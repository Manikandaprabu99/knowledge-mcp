#!/usr/bin/env node
import { errorMessage } from "../utils/errors.js";
import { createLogger } from "../utils/logger.js";
import {
  createAppServices,
  loadConfigOrExit,
  shutdownServices,
  startDatabaseInitialization,
  startMaintenance,
} from "./bootstrap.js";
import { createHttpApp } from "./http-app.js";

/** Remote transport entry point (Streamable HTTP). */
async function main(): Promise<void> {
  const config = loadConfigOrExit("http");
  const logger = createLogger(config.logLevel, { transport: "http" });
  process.on("unhandledRejection", (reason) => logger.error("Unhandled promise rejection", { reason: errorMessage(reason) }));

  const services = createAppServices(config, logger);
  const stopInitialization = startDatabaseInitialization(services);
  const stopMaintenance = startMaintenance(services);
  const app = createHttpApp(services);

  app.server.on("error", (error: NodeJS.ErrnoException) => {
    const hint = error.code === "EADDRINUSE" ? ` Port ${config.port} is already in use; set MCP_SERVER_PORT.` : "";
    logger.error(`HTTP server failed to start.${hint}`, { error });
    process.exit(1);
  });
  app.server.listen(config.port, config.host, () => {
    logger.info("Universal Knowledge MCP server listening", {
      endpoint: `http://${config.host}:${config.port}/mcp`,
      sessions: config.httpSessionMode,
    });
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("Shutting down", { signal });
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    stopInitialization();
    stopMaintenance();
    await app.close();
    await shutdownServices(services);
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((error: unknown) => {
  process.stderr.write(`[universal-knowledge-mcp] Fatal: ${errorMessage(error)}\n`);
  process.exit(1);
});
