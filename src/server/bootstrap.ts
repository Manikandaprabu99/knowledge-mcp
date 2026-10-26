import { loadConfig, loadDotEnvFile, type AppConfig, type RuntimeMode } from "../config/env.js";
import { Database } from "../database/client.js";
import { assertSchemaReady, runMigrations } from "../database/migrator.js";
import { AuditRepository } from "../database/repositories/audit-repository.js";
import { DocumentRepository } from "../database/repositories/document-repository.js";
import { SearchRepository } from "../database/repositories/search-repository.js";
import { UsageRepository } from "../database/repositories/usage-repository.js";
import { UserRepository } from "../database/repositories/user-repository.js";
import { Authenticator } from "../security/authentication.js";
import { DuplicateDetector } from "../services/deduplication.js";
import { EmbeddingIndex } from "../services/embeddings.js";
import { KnowledgeSearchService, type SearchResponse } from "../services/knowledge-search.js";
import { KnowledgeStorageService } from "../services/knowledge-storage.js";
import { UsageMetrics } from "../services/usage-metrics.js";
import { ConfigError, errorMessage } from "../utils/errors.js";
import type { Logger } from "../utils/logger.js";
import { LruCache } from "../utils/lru-cache.js";

export interface AppServices {
  config: AppConfig;
  logger: Logger;
  db: Database;
  users: UserRepository;
  documents: DocumentRepository;
  audit: AuditRepository;
  usage: UsageRepository;
  auth: Authenticator;
  metrics: UsageMetrics;
  storage: KnowledgeStorageService;
  search: KnowledgeSearchService;
  embeddings: EmbeddingIndex | null;
  state: { databaseReady: boolean; lastError: string | null };
}

/** Composition root: wires every dependency explicitly (no singletons). Does not connect yet. */
export function createAppServices(config: AppConfig, logger: Logger): AppServices {
  const db = new Database(
    { url: config.databaseUrl, ssl: config.databaseSsl, poolMax: config.dbPoolMax, queryTimeoutMs: config.dbQueryTimeoutMs },
    logger.child({ component: "database" }),
  );
  const users = new UserRepository(db);
  const documents = new DocumentRepository(db);
  const audit = new AuditRepository(db);
  const usage = new UsageRepository(db);
  const metrics = new UsageMetrics(usage, logger.child({ component: "metrics" }));
  const embeddings = config.embeddings
    ? new EmbeddingIndex(config.embeddings, db, logger.child({ component: "embeddings" }))
    : null;
  const cache = new LruCache<SearchResponse>(config.search.cacheMaxEntries, config.search.cacheTtlMs);
  const storage = new KnowledgeStorageService({
    db,
    documents,
    audit,
    duplicates: new DuplicateDetector(documents, config.duplicateThreshold),
    metrics,
    logger: logger.child({ component: "storage" }),
    config: {
      namespace: config.namespace,
      defaultVisibility: config.defaultVisibility,
      maxDocumentBytes: config.maxDocumentBytes,
      redactEmails: config.redactEmails,
    },
    embeddings,
    onChange: () => cache.clear(),
  });
  const search = new KnowledgeSearchService({
    repository: new SearchRepository(db),
    storage,
    metrics,
    logger: logger.child({ component: "search" }),
    config: config.search,
    embeddings,
    cache,
  });
  const auth = new Authenticator(
    { authToken: config.authToken, authUserId: config.authUserId, authOrgId: config.authOrgId },
    users,
  );
  return {
    config,
    logger,
    db,
    users,
    documents,
    audit,
    usage,
    auth,
    metrics,
    storage,
    search,
    embeddings,
    state: { databaseReady: false, lastError: null },
  };
}

/** Migrates (if enabled), verifies the schema, and makes sure the bootstrap admin exists. */
export async function initializeDatabase(services: AppServices): Promise<void> {
  const { config, db, logger } = services;
  if (config.autoMigrate) await runMigrations(db, logger.child({ component: "migrate" }));
  await assertSchemaReady(db);
  await services.users.ensureUser({
    id: config.authUserId,
    displayName: config.authUserId,
    orgId: config.authOrgId,
    role: "admin",
    canReadPublic: true,
  });
  if (services.embeddings) await services.embeddings.ensureSchema();
  services.state.databaseReady = true;
  services.state.lastError = null;
}

/** Keeps retrying initialization in the background, so a sleeping or unreachable database never crashes the process. */
export function startDatabaseInitialization(services: AppServices): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let delayMs = 2_000;
  const attempt = async (): Promise<void> => {
    try {
      await initializeDatabase(services);
      services.logger.info("Knowledge database ready");
    } catch (error) {
      services.state.databaseReady = false;
      services.state.lastError = errorMessage(error);
      services.logger.warn("Knowledge database not ready; retrying", { reason: errorMessage(error), retryInMs: delayMs });
      if (stopped) return;
      timer = setTimeout(() => void attempt(), delayMs);
      timer.unref();
      delayMs = Math.min(delayMs * 2, 60_000);
    }
  };
  void attempt();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

/** Periodic metric flushing and retention cleanup (archived documents, audit log). */
export function startMaintenance(services: AppServices): () => void {
  const { config, logger } = services;
  services.metrics.start();
  const run = async (): Promise<void> => {
    if (!services.state.databaseReady) return;
    try {
      const purged = config.archiveRetentionDays > 0 ? await services.documents.purgeArchived(config.archiveRetentionDays) : [];
      const audits = config.auditRetentionDays > 0 ? await services.audit.purgeOlderThan(config.auditRetentionDays) : 0;
      if (purged.length > 0) {
        await services.audit.record({ actorId: null, action: "retention.purged", details: { documents: purged.length } });
      }
      if (purged.length > 0 || audits > 0) {
        logger.info("Retention cleanup", { purgedDocuments: purged.length, purgedAuditEntries: audits });
      }
    } catch (error) {
      logger.warn("Retention cleanup failed", { reason: errorMessage(error) });
    }
  };
  const first = setTimeout(() => void run(), 60_000);
  const hourly = setInterval(() => void run(), 3_600_000);
  first.unref();
  hourly.unref();
  return () => {
    clearTimeout(first);
    clearInterval(hourly);
  };
}

export async function shutdownServices(services: AppServices): Promise<void> {
  await services.metrics.stop().catch(() => undefined);
  await services.db.close().catch(() => undefined);
}

/** Loads .env + environment; on invalid configuration prints actionable problems to stderr and exits. */
export function loadConfigOrExit(mode: RuntimeMode): AppConfig {
  try {
    loadDotEnvFile();
    return loadConfig(process.env, mode);
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`[universal-knowledge-mcp] ${error.message}\nSee .env.example and docs/TROUBLESHOOTING.md.\n`);
      process.exit(1);
    }
    throw error;
  }
}
