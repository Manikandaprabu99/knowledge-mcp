import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { TLSSocket } from "node:tls";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { extractBearerToken } from "../security/authentication.js";
import { RateLimiter } from "../security/rate-limiter.js";
import type { Identity } from "../types/domain.js";
import { AppError, errorMessage } from "../utils/errors.js";
import { KNOWLEDGE_ID_PATTERN } from "../utils/ids.js";
import { APP_VERSION } from "../version.js";
import type { AppServices } from "./bootstrap.js";
import { createKnowledgeServer } from "./index.js";
import { createHttpSession, type HttpSessionContext } from "./session.js";

const MAX_SESSIONS = 1_000;
const EXPORT_PATH = /^\/export\/([^/]+)\.md$/;

interface HttpSession {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  context: HttpSessionContext;
  lastSeenAt: number;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly rpcCode = -32600,
  ) {
    super(message);
  }
}

export interface HttpApp {
  readonly server: Server;
  readonly sessionCount: number;
  close(): Promise<void>;
}

/**
 * Streamable HTTP transport with bearer authentication on every request, sessions bound to one identity,
 * Origin validation, rate limiting, health/readiness probes and an authenticated Markdown download endpoint.
 */
export function createHttpApp(services: AppServices): HttpApp {
  const { config, logger } = services;
  const sessions = new Map<string, HttpSession>();
  const limiter = new RateLimiter(config.rateLimitPerMinute);
  const authFailures = new RateLimiter(30);

  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      if (error instanceof HttpError) return sendJson(res, error.status, rpcError(error.rpcCode, error.message));
      logger.error("Unhandled HTTP error", { error });
      return sendJson(res, 500, rpcError(-32603, "Internal server error."));
    });
  });
  server.requestTimeout = config.requestTimeoutMs;
  server.headersTimeout = Math.min(config.requestTimeoutMs, 60_000);
  server.keepAliveTimeout = 65_000;

  const sweeper = setInterval(() => {
    const cutoff = Date.now() - config.sessionIdleTimeoutMs;
    for (const [id, session] of sessions) {
      if (session.lastSeenAt >= cutoff) continue;
      sessions.delete(id);
      void closeSession(session);
      logger.info("MCP session expired", { sessionId: id });
    }
    limiter.prune();
    authFailures.prune();
  }, 60_000);
  sweeper.unref();

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    setSecurityHeaders(res);
    const url = new URL(req.url ?? "/", "http://localhost");
    const origin = header(req, "origin");
    if (origin) {
      // Browsers always send Origin; rejecting unknown origins blocks DNS-rebinding and cross-site calls.
      if (!config.allowedOrigins.includes(origin)) return sendJson(res, 403, rpcError(-32600, "Origin not allowed."));
      setCorsHeaders(res, origin);
      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }
    }
    if (req.method === "GET" && url.pathname === "/healthz") return sendJson(res, 200, { status: "ok", version: APP_VERSION });
    if (req.method === "GET" && url.pathname === "/readyz") return readiness(res);
    if (!isHttpsAllowed(req)) return sendJson(res, 400, rpcError(-32600, "HTTPS is required."));
    if (url.pathname === "/mcp") return handleMcp(req, res);
    const exportId = EXPORT_PATH.exec(url.pathname)?.[1];
    if (req.method === "GET" && exportId) return handleExport(req, res, exportId, url);
    return sendJson(res, 404, { error: "not_found" });
  }

  async function readiness(res: ServerResponse): Promise<void> {
    const reachable = await services.db.ping();
    const ready = reachable && services.state.databaseReady;
    sendJson(res, ready ? 200 : 503, {
      status: ready ? "ready" : "not_ready",
      database: reachable ? "reachable" : "unreachable",
      schema: services.state.databaseReady ? "ready" : "pending",
    });
  }

  async function authenticate(req: IncomingMessage, res: ServerResponse): Promise<Identity | null> {
    const token = extractBearerToken(req.headers.authorization);
    let identity: Identity | null = null;
    try {
      identity = token ? await services.auth.authenticate(token) : null;
    } catch (error) {
      logger.warn("Authentication backend error", { reason: errorMessage(error) });
      sendJson(res, 503, rpcError(-32003, "Authentication is temporarily unavailable; retry shortly."));
      return null;
    }
    if (!identity) {
      const blocked = !authFailures.consume(`ip:${clientIp(req)}`).allowed;
      res.setHeader("WWW-Authenticate", 'Bearer realm="universal-knowledge-mcp"');
      sendJson(
        res,
        blocked ? 429 : 401,
        rpcError(-32001, blocked ? "Too many failed authentication attempts." : "Unauthorized: send Authorization: Bearer <token>."),
      );
      return null;
    }
    const allowance = limiter.consume(`user:${identity.userId}`);
    if (!allowance.allowed) {
      res.setHeader("Retry-After", String(allowance.retryAfterSeconds));
      sendJson(res, 429, rpcError(-32002, "Rate limit exceeded; retry later."));
      return null;
    }
    return identity;
  }

  async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const identity = await authenticate(req, res);
    if (!identity) return;
    if (config.httpSessionMode === "stateless") return handleStateless(req, res, identity);

    const sessionId = header(req, "mcp-session-id");
    if (req.method === "POST") {
      const body = await readJsonBody(req, config.maxRequestBytes);
      if (sessionId) return forward(sessionId, identity, req, res, body);
      if (!isInitializeRequest(body)) {
        throw new HttpError(400, "Bad Request: send an initialize request first or include a valid Mcp-Session-Id header.", -32000);
      }
      if (sessions.size >= MAX_SESSIONS) throw new HttpError(503, "Too many active sessions; retry later.", -32000);

      const context = createHttpSession(identity);
      const mcpServer = createKnowledgeServer(services, context);
      const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id: string) => {
          sessions.set(id, { transport, server: mcpServer, context, lastSeenAt: Date.now() });
          logger.info("MCP session started", { sessionId: id, userId: identity.userId });
        },
      });
      transport.onclose = () => {
        const id = transport.sessionId;
        if (id && sessions.delete(id)) logger.info("MCP session closed", { sessionId: id });
      };
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, body);
      return;
    }
    if (req.method === "GET" || req.method === "DELETE") {
      if (!sessionId) throw new HttpError(400, "Missing Mcp-Session-Id header.", -32000);
      return forward(sessionId, identity, req, res);
    }
    res.setHeader("Allow", "GET, POST, DELETE");
    throw new HttpError(405, "Method not allowed.", -32000);
  }

  async function forward(
    sessionId: string,
    identity: Identity,
    req: IncomingMessage,
    res: ServerResponse,
    body?: unknown,
  ): Promise<void> {
    const session = sessions.get(sessionId);
    if (!session) throw new HttpError(404, "Session not found; start a new session with an initialize request.", -32001);
    if (session.context.userId !== identity.userId) throw new HttpError(403, "This session belongs to a different identity.");
    session.context.setIdentity(identity);
    session.lastSeenAt = Date.now();
    await session.transport.handleRequest(req, res, body);
  }

  async function handleStateless(req: IncomingMessage, res: ServerResponse, identity: Identity): Promise<void> {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      throw new HttpError(405, "Stateless mode accepts POST requests only.", -32000);
    }
    const body = await readJsonBody(req, config.maxRequestBytes);
    const mcpServer = createKnowledgeServer(services, createHttpSession(identity));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void mcpServer.close();
    });
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  async function handleExport(req: IncomingMessage, res: ServerResponse, knowledgeId: string, url: URL): Promise<void> {
    if (!KNOWLEDGE_ID_PATTERN.test(knowledgeId)) return sendJson(res, 404, { error: "not_found" });
    const identity = await authenticate(req, res);
    if (!identity) return;
    const versionParam = url.searchParams.get("version");
    const version = versionParam === null ? undefined : Number(versionParam);
    if (version !== undefined && (!Number.isInteger(version) || version < 1)) {
      return sendJson(res, 400, { error: "validation_error", message: "version must be a positive integer." });
    }
    try {
      const exported = await services.storage.export(identity, knowledgeId, version);
      res.writeHead(200, {
        "content-type": "text/markdown; charset=utf-8",
        "content-disposition": `attachment; filename="${exported.fileName}"`,
        etag: `"${exported.contentHash}"`,
      });
      res.end(exported.markdown);
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      const status =
        error.code === "NOT_FOUND" ? 404 : error.code === "VALIDATION_ERROR" ? 400 : error.code === "DATABASE_UNAVAILABLE" || error.code === "SCHEMA_NOT_READY" ? 503 : 500;
      sendJson(res, status, { error: error.code.toLowerCase(), message: error.message });
    }
  }

  function isHttpsAllowed(req: IncomingMessage): boolean {
    if (!config.requireHttps) return true;
    if ((req.socket as TLSSocket).encrypted) return true;
    return config.trustProxy && header(req, "x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase() === "https";
  }

  function clientIp(req: IncomingMessage): string {
    if (config.trustProxy) {
      const forwarded = header(req, "x-forwarded-for")?.split(",")[0]?.trim();
      if (forwarded) return forwarded;
    }
    return req.socket.remoteAddress ?? "unknown";
  }

  return {
    server,
    get sessionCount() {
      return sessions.size;
    },
    close: async () => {
      clearInterval(sweeper);
      const open = [...sessions.values()];
      sessions.clear();
      await Promise.all(open.map((session) => closeSession(session)));
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}

async function closeSession(session: HttpSession): Promise<void> {
  await session.transport.close().catch(() => undefined);
  await session.server.close().catch(() => undefined);
}

async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
    size += buffer.length;
    if (size > maxBytes) throw new HttpError(413, `Request body exceeds ${maxBytes} bytes.`);
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) throw new HttpError(400, "Empty request body.", -32700);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(400, "Parse error: request body is not valid JSON.", -32700);
  }
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function rpcError(code: number, message: string): { jsonrpc: "2.0"; error: { code: number; message: string }; id: null } {
  return { jsonrpc: "2.0", error: { code, message }, id: null };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function setSecurityHeaders(res: ServerResponse): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cache-Control", "no-store");
}

function setCorsHeaders(res: ServerResponse, origin: string): void {
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Authorization, Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID",
  );
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
}
