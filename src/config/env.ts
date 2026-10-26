import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { z } from "zod";
import { API_TOKEN_PATTERN } from "../security/authentication.js";
import { IDENTIFIER_PATTERN, type Visibility } from "../types/domain.js";
import { ConfigError } from "../utils/errors.js";
import { LOG_LEVELS, type LogLevel } from "../utils/logger.js";

export type RuntimeMode = "http" | "stdio" | "cli";
export type DatabaseSslMode = "auto" | "disable" | "require" | "no-verify";
export type HttpSessionMode = "stateful" | "stateless";

export interface EmbeddingsConfig {
  url: string;
  model: string;
  apiKey: string | undefined;
  timeoutMs: number;
}

export interface SearchConfig {
  defaultLimit: number;
  maxLimit: number;
  minScore: number;
  cacheTtlMs: number;
  cacheMaxEntries: number;
  staleAfterDays: number;
}

export interface AppConfig {
  mode: RuntimeMode;
  databaseUrl: string;
  databaseSsl: DatabaseSslMode;
  dbPoolMax: number;
  dbQueryTimeoutMs: number;
  host: string;
  port: number;
  authToken: string | undefined;
  userToken: string | undefined;
  authUserId: string;
  authOrgId: string;
  namespace: string;
  defaultVisibility: Extract<Visibility, "private" | "shared">;
  logLevel: LogLevel;
  httpSessionMode: HttpSessionMode;
  sessionIdleTimeoutMs: number;
  allowedOrigins: string[];
  trustProxy: boolean;
  requireHttps: boolean;
  rateLimitPerMinute: number;
  requestTimeoutMs: number;
  toolTimeoutMs: number;
  maxRequestBytes: number;
  search: SearchConfig;
  duplicateThreshold: number;
  archiveRetentionDays: number;
  auditRetentionDays: number;
  maxDocumentBytes: number;
  redactEmails: boolean;
  autoMigrate: boolean;
  embeddings: EmbeddingsConfig | null;
}

const TOKEN_HINT =
  "Generate one with: node -e \"console.log(require('node:crypto').randomBytes(32).toString('base64url'))\"";

const HINTS: Record<string, string> = {
  DATABASE_URL:
    "Set it to a PostgreSQL connection string, e.g. postgres://user:password@localhost:5432/knowledge (see .env.example).",
  MCP_AUTH_TOKEN: TOKEN_HINT,
  KNOWLEDGE_NAMESPACE: "Use lowercase letters, digits, '.', '_' or '-' (max 64 characters).",
  MCP_AUTH_USER_ID: "Use lowercase letters, digits, '.', '_' or '-' (max 64 characters).",
  MCP_AUTH_ORG_ID: "Use lowercase letters, digits, '.', '_' or '-' (max 64 characters).",
  DEFAULT_VISIBILITY: "Public visibility can only be chosen explicitly by an organization admin.",
};

const TRUE_VALUES = new Set(["true", "1", "yes", "on"]);
const FALSE_VALUES = new Set(["false", "0", "no", "off"]);

const flag = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((value, ctx): boolean => {
      if (value === undefined) return fallback;
      const normalized = value.trim().toLowerCase();
      if (TRUE_VALUES.has(normalized)) return true;
      if (FALSE_VALUES.has(normalized)) return false;
      ctx.addIssue({ code: "custom", message: `expected true or false but got "${value}"` });
      return z.NEVER;
    });

const integer = (fallback: number, min: number, max: number) =>
  z
    .string()
    .optional()
    .transform((value, ctx): number => {
      if (value === undefined) return fallback;
      const parsed = Number(value.trim());
      if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
        ctx.addIssue({ code: "custom", message: `expected an integer between ${min} and ${max} but got "${value}"` });
        return z.NEVER;
      }
      return parsed;
    });

const decimal = (fallback: number, min: number, max: number) =>
  z
    .string()
    .optional()
    .transform((value, ctx): number => {
      if (value === undefined) return fallback;
      const parsed = Number(value.trim());
      if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
        ctx.addIssue({ code: "custom", message: `expected a number between ${min} and ${max} but got "${value}"` });
        return z.NEVER;
      }
      return parsed;
    });

const oneOf = <T extends string>(values: readonly T[], fallback: T) =>
  z
    .string()
    .optional()
    .transform((value, ctx): T => {
      if (value === undefined) return fallback;
      const normalized = value.trim().toLowerCase();
      const match = values.find((candidate) => candidate === normalized);
      if (match === undefined) {
        ctx.addIssue({ code: "custom", message: `expected one of ${values.join(", ")} but got "${value}"` });
        return z.NEVER;
      }
      return match;
    });

const identifier = (fallback: string) =>
  z
    .string()
    .optional()
    .transform((value, ctx): string => {
      if (value === undefined) return fallback;
      const normalized = value.trim();
      if (!IDENTIFIER_PATTERN.test(normalized)) {
        ctx.addIssue({ code: "custom", message: `"${value}" is not a valid identifier` });
        return z.NEVER;
      }
      return normalized;
    });

const envSchema = z.object({
  DATABASE_URL: z.string().optional(),
  DATABASE_SSL: oneOf(["auto", "disable", "require", "no-verify"] as const, "auto"),
  DB_POOL_MAX: integer(5, 1, 100),
  DB_QUERY_TIMEOUT_MS: integer(15_000, 1_000, 300_000),
  MCP_SERVER_PORT: z.string().optional(),
  PORT: z.string().optional(),
  MCP_HOST: z.string().optional(),
  MCP_AUTH_TOKEN: z.string().optional(),
  MCP_USER_TOKEN: z.string().optional(),
  MCP_AUTH_USER_ID: identifier("owner"),
  MCP_AUTH_ORG_ID: identifier("default"),
  KNOWLEDGE_NAMESPACE: identifier("default"),
  DEFAULT_VISIBILITY: oneOf(["private", "shared"] as const, "private"),
  LOG_LEVEL: oneOf(LOG_LEVELS, "info"),
  MCP_HTTP_SESSIONS: oneOf(["stateful", "stateless"] as const, "stateful"),
  SESSION_IDLE_TIMEOUT_MINUTES: integer(30, 1, 1_440),
  ALLOWED_ORIGINS: z.string().optional(),
  TRUST_PROXY: flag(false),
  REQUIRE_HTTPS: flag(false),
  RATE_LIMIT_PER_MINUTE: integer(120, 0, 100_000),
  REQUEST_TIMEOUT_MS: integer(30_000, 1_000, 600_000),
  TOOL_TIMEOUT_MS: integer(20_000, 1_000, 300_000),
  MAX_REQUEST_BYTES: integer(1_048_576, 1_024, 20_971_520),
  SEARCH_DEFAULT_LIMIT: integer(5, 1, 50),
  SEARCH_MAX_LIMIT: integer(20, 1, 100),
  SEARCH_MIN_SCORE: decimal(0.15, 0, 1),
  SEARCH_CACHE_TTL_SECONDS: integer(60, 0, 86_400),
  SEARCH_CACHE_MAX_ENTRIES: integer(500, 0, 100_000),
  DUPLICATE_SIMILARITY_THRESHOLD: decimal(0.6, 0.1, 1),
  STALE_AFTER_DAYS: integer(365, 1, 36_500),
  ARCHIVE_RETENTION_DAYS: integer(30, 0, 36_500),
  AUDIT_RETENTION_DAYS: integer(180, 0, 36_500),
  MAX_DOCUMENT_BYTES: integer(102_400, 1_024, 5_242_880),
  REDACT_EMAILS: flag(true),
  AUTO_MIGRATE: flag(false),
  EMBEDDINGS_URL: z.string().optional(),
  EMBEDDINGS_MODEL: z.string().optional(),
  EMBEDDINGS_API_KEY: z.string().optional(),
  EMBEDDINGS_TIMEOUT_MS: integer(5_000, 500, 60_000),
});

/**
 * Validates environment variables and returns a typed configuration.
 * Throws ConfigError with one actionable sentence per problem; secret values are never echoed.
 */
export function loadConfig(env: NodeJS.ProcessEnv, mode: RuntimeMode): AppConfig {
  const raw: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string" && value.trim() !== "") raw[key] = value;
  }

  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => {
        const key = String(issue.path[0] ?? "configuration");
        return `${key}: ${issue.message}. ${HINTS[key] ?? ""}`.trim();
      }),
    );
  }

  const values = parsed.data;
  const problems: string[] = [];
  const databaseUrl = validateDatabaseUrl(values.DATABASE_URL, problems);
  const port = parsePort(values.MCP_SERVER_PORT ?? values.PORT ?? "3000", problems);
  const authToken = values.MCP_AUTH_TOKEN?.trim();
  const userToken = values.MCP_USER_TOKEN?.trim();
  validateTokens(mode, authToken, userToken, problems);

  if (values.SEARCH_DEFAULT_LIMIT > values.SEARCH_MAX_LIMIT) {
    problems.push("SEARCH_DEFAULT_LIMIT must not be greater than SEARCH_MAX_LIMIT.");
  }

  const allowedOrigins = parseOrigins(values.ALLOWED_ORIGINS, problems);
  const embeddings = parseEmbeddings(values, problems);

  if (problems.length > 0) throw new ConfigError(problems);

  return {
    mode,
    databaseUrl,
    databaseSsl: values.DATABASE_SSL,
    dbPoolMax: values.DB_POOL_MAX,
    dbQueryTimeoutMs: values.DB_QUERY_TIMEOUT_MS,
    host: values.MCP_HOST?.trim() || "127.0.0.1",
    port,
    authToken,
    userToken,
    authUserId: values.MCP_AUTH_USER_ID,
    authOrgId: values.MCP_AUTH_ORG_ID,
    namespace: values.KNOWLEDGE_NAMESPACE,
    defaultVisibility: values.DEFAULT_VISIBILITY,
    logLevel: values.LOG_LEVEL,
    httpSessionMode: values.MCP_HTTP_SESSIONS,
    sessionIdleTimeoutMs: values.SESSION_IDLE_TIMEOUT_MINUTES * 60_000,
    allowedOrigins,
    trustProxy: values.TRUST_PROXY,
    requireHttps: values.REQUIRE_HTTPS,
    rateLimitPerMinute: values.RATE_LIMIT_PER_MINUTE,
    requestTimeoutMs: values.REQUEST_TIMEOUT_MS,
    toolTimeoutMs: values.TOOL_TIMEOUT_MS,
    maxRequestBytes: values.MAX_REQUEST_BYTES,
    search: {
      defaultLimit: values.SEARCH_DEFAULT_LIMIT,
      maxLimit: values.SEARCH_MAX_LIMIT,
      minScore: values.SEARCH_MIN_SCORE,
      cacheTtlMs: values.SEARCH_CACHE_TTL_SECONDS * 1_000,
      cacheMaxEntries: values.SEARCH_CACHE_MAX_ENTRIES,
      staleAfterDays: values.STALE_AFTER_DAYS,
    },
    duplicateThreshold: values.DUPLICATE_SIMILARITY_THRESHOLD,
    archiveRetentionDays: values.ARCHIVE_RETENTION_DAYS,
    auditRetentionDays: values.AUDIT_RETENTION_DAYS,
    maxDocumentBytes: values.MAX_DOCUMENT_BYTES,
    redactEmails: values.REDACT_EMAILS,
    autoMigrate: values.AUTO_MIGRATE,
    embeddings,
  };
}

/**
 * Loads KEY=VALUE pairs from ENV_FILE or ./.env without overriding variables that are already set.
 * Returns the loaded path, or null when no file exists.
 */
export function loadDotEnvFile(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env.ENV_FILE?.trim();
  const path = resolve(explicit || ".env");
  if (!existsSync(path)) {
    if (explicit) throw new ConfigError([`ENV_FILE points to ${path}, which does not exist.`]);
    return null;
  }
  const values = parseEnv(readFileSync(path, "utf8"));
  for (const [key, value] of Object.entries(values)) {
    if (env[key] === undefined && value !== undefined) env[key] = value;
  }
  return path;
}

function validateDatabaseUrl(value: string | undefined, problems: string[]): string {
  if (!value) {
    problems.push(`DATABASE_URL is required. ${HINTS.DATABASE_URL}`);
    return "";
  }
  const trimmed = value.trim();
  if (!/^postgres(?:ql)?:\/\//i.test(trimmed)) {
    problems.push(`DATABASE_URL must start with postgres:// or postgresql://. ${HINTS.DATABASE_URL}`);
    return "";
  }
  try {
    new URL(trimmed);
  } catch {
    problems.push(
      "DATABASE_URL is not a valid URL. URL-encode special characters in the user name or password (for example '@' becomes %40).",
    );
    return "";
  }
  return trimmed;
}

function parsePort(value: string, problems: string[]): number {
  const port = Number(value.trim());
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    problems.push("MCP_SERVER_PORT (or PORT) must be an integer between 1 and 65535.");
    return 0;
  }
  return port;
}

function validateTokens(
  mode: RuntimeMode,
  authToken: string | undefined,
  userToken: string | undefined,
  problems: string[],
): void {
  if (authToken !== undefined) {
    if (authToken.startsWith("replace-with")) {
      problems.push(`MCP_AUTH_TOKEN still has the placeholder value from .env.example. ${TOKEN_HINT}`);
    } else if (authToken.length < 32) {
      problems.push(`MCP_AUTH_TOKEN must be at least 32 characters long (it has ${authToken.length}). ${TOKEN_HINT}`);
    }
  }
  if (mode === "http" && !authToken) {
    problems.push(`MCP_AUTH_TOKEN is required for the HTTP server. ${TOKEN_HINT}`);
  }
  if (userToken !== undefined && !API_TOKEN_PATTERN.test(userToken)) {
    problems.push(
      "MCP_USER_TOKEN must be a personal token issued with `npm run admin -- token:create <user-id>` (it starts with ukm_).",
    );
  }
  if (mode === "stdio" && !authToken && !userToken) {
    problems.push(
      "Set MCP_USER_TOKEN (your personal ukm_ token) or MCP_AUTH_TOKEN (single-user/admin) for stdio mode. " +
        "When an AI client launches the server, put them in the client's MCP \"env\" block or in a .env file (ENV_FILE=/path/to/.env).",
    );
  }
}

function parseOrigins(value: string | undefined, problems: string[]): string[] {
  if (!value) return [];
  const origins = value
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  for (const origin of origins) {
    let valid = false;
    try {
      valid = new URL(origin).origin === origin;
    } catch {
      valid = false;
    }
    if (!valid) problems.push(`ALLOWED_ORIGINS contains "${origin}", which is not an origin like https://app.example.com.`);
  }
  return origins;
}

function parseEmbeddings(
  values: { EMBEDDINGS_URL?: string; EMBEDDINGS_MODEL?: string; EMBEDDINGS_API_KEY?: string; EMBEDDINGS_TIMEOUT_MS: number },
  problems: string[],
): EmbeddingsConfig | null {
  const url = values.EMBEDDINGS_URL?.trim();
  if (!url) return null;
  if (!/^https?:\/\//i.test(url)) {
    problems.push("EMBEDDINGS_URL must be an http(s) URL of an OpenAI-compatible API, e.g. http://localhost:11434/v1.");
  }
  const model = values.EMBEDDINGS_MODEL?.trim();
  if (!model) problems.push("EMBEDDINGS_MODEL is required when EMBEDDINGS_URL is set (e.g. nomic-embed-text).");
  return {
    url: url.replace(/\/+$/, ""),
    model: model ?? "",
    apiKey: values.EMBEDDINGS_API_KEY?.trim() || undefined,
    timeoutMs: values.EMBEDDINGS_TIMEOUT_MS,
  };
}
