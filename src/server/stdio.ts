#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { errorMessage } from "../utils/errors.js";
import { createLogger } from "../utils/logger.js";
import {
  createAppServices,
  loadConfigOrExit,
  shutdownServices,
  startDatabaseInitialization,
  startMaintenance,
} from "./bootstrap.js";
import { createKnowledgeServer } from "./index.js";
import { createStdioSession } from "./session.js";

/** Local transport: the AI client launches this process; stdout carries MCP messages, logs go to stderr. */
async function main(): Promise<void> {
  const config = loadConfigOrExit("stdio");
  const logger = createLogger(config.logLevel, { transport: "stdio" });
  process.on("unhandledRejection", (reason) => logger.error("Unhandled promise rejection", { reason: errorMessage(reason) }));

  const services = createAppServices(config, logger);
  const stopInitialization = startDatabaseInitialization(services);
  const stopMaintenance = startMaintenance(services);
  const token = config.userToken ?? config.authToken ?? "";
  const server = createKnowledgeServer(services, createStdioSession(services.auth, token));
  await server.connect(new StdioServerTransport());
  logger.info("Universal Knowledge MCP server running on stdio");

  let shuttingDown = false;
  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("Shutting down", { reason });
    stopInitialization();
    stopMaintenance();
    await server.close().catch(() => undefined);
    await shutdownServices(services);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.stdin.on("close", () => void shutdown("stdin closed"));
}

main().catch((error: unknown) => {
  process.stderr.write(`[universal-knowledge-mcp] Fatal: ${errorMessage(error)}\n`);
  process.exit(1);
});
