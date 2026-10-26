#!/usr/bin/env node
import { parseArgs } from "node:util";
import { loadConfig, loadDotEnvFile } from "../config/env.js";
import { Database } from "../database/client.js";
import { assertSchemaReady } from "../database/migrator.js";
import { DocumentRepository } from "../database/repositories/document-repository.js";
import { UserRepository } from "../database/repositories/user-repository.js";
import { IDENTIFIER_PATTERN, ROLES, type Role } from "../types/domain.js";
import { AppError, ConfigError, errorMessage } from "../utils/errors.js";
import { KNOWLEDGE_ID_PATTERN } from "../utils/ids.js";
import { createLogger } from "../utils/logger.js";

const USAGE = `Universal Knowledge MCP admin CLI (operator access: uses DATABASE_URL directly)

  npm run admin -- user:create <user-id> --org <org-id> [--name "Display Name"] [--role admin|member|reader] [--public-read]
  npm run admin -- user:list
  npm run admin -- user:update <user-id> [--role <role>] [--name <name>] [--public-read | --no-public-read]
  npm run admin -- user:disable <user-id>
  npm run admin -- user:enable <user-id>
  npm run admin -- token:create <user-id> [--label laptop] [--expires-days 90]
  npm run admin -- token:list <user-id>
  npm run admin -- token:revoke <token-id>
  npm run admin -- grant:add <knowledge-id> <user-id> [--write]
  npm run admin -- grant:remove <knowledge-id> <user-id>
`;

const print = (line = ""): void => {
  process.stdout.write(`${line}\n`);
};

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      org: { type: "string" },
      name: { type: "string" },
      role: { type: "string" },
      label: { type: "string" },
      "expires-days": { type: "string" },
      "public-read": { type: "boolean" },
      "no-public-read": { type: "boolean" },
      write: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [command, first, second] = positionals;
  if (!command || values.help) {
    print(USAGE);
    return;
  }

  loadDotEnvFile();
  const config = loadConfig(process.env, "cli");
  const db = new Database({ url: config.databaseUrl, ssl: config.databaseSsl, poolMax: 2, queryTimeoutMs: 30_000 }, createLogger("warn"));
  const users = new UserRepository(db);
  const documents = new DocumentRepository(db);
  try {
    await assertSchemaReady(db);
    switch (command) {
      case "user:create": {
        const id = requireIdentifier(first, "user-id");
        const user = await users.createUser({
          id,
          orgId: requireIdentifier(values.org, "--org"),
          displayName: values.name ?? id,
          role: parseRole(values.role ?? "member"),
          canReadPublic: values["public-read"] === true,
        });
        print(`Created user ${user.id} (org ${user.orgId}, role ${user.role}). Issue a token with: npm run admin -- token:create ${user.id}`);
        break;
      }
      case "user:list":
        for (const user of await users.listUsers()) {
          print(`${user.id}\torg=${user.orgId}\trole=${user.role}\tpublic-read=${user.canReadPublic}\tactive=${user.isActive}`);
        }
        break;
      case "user:update": {
        const publicRead = values["public-read"] ? true : values["no-public-read"] ? false : undefined;
        const user = await users.updateUser(requireIdentifier(first, "user-id"), {
          role: values.role === undefined ? undefined : parseRole(values.role),
          displayName: values.name,
          canReadPublic: publicRead,
        });
        print(user ? `Updated ${user.id}: role=${user.role}, public-read=${user.canReadPublic}` : "User not found.");
        break;
      }
      case "user:disable":
      case "user:enable": {
        const user = await users.updateUser(requireIdentifier(first, "user-id"), { isActive: command === "user:enable" });
        print(user ? `${user.id} is now ${user.isActive ? "enabled" : "disabled"}.` : "User not found.");
        break;
      }
      case "token:create": {
        const days = values["expires-days"] === undefined ? undefined : Number(values["expires-days"]);
        if (days !== undefined && (!Number.isInteger(days) || days < 1)) throw new AppError("VALIDATION_ERROR", "--expires-days must be a positive integer.");
        const issued = await users.createToken(requireIdentifier(first, "user-id"), {
          label: values.label,
          expiresAt: days === undefined ? null : new Date(Date.now() + days * 86_400_000),
        });
        print(`Token id: ${issued.tokenId}${issued.expiresAt ? ` (expires ${issued.expiresAt.toISOString()})` : ""}`);
        print(`Token:    ${issued.token}`);
        print("Store it in a password manager now; it cannot be shown again (only its SHA-256 hash is stored).");
        break;
      }
      case "token:list":
        for (const token of await users.listTokens(requireIdentifier(first, "user-id"))) {
          const state = token.revokedAt ? "revoked" : token.expiresAt && token.expiresAt < new Date() ? "expired" : "active";
          print(`${token.id}\t${state}\tlabel=${token.label ?? "-"}\tcreated=${token.createdAt.toISOString()}\tlast-used=${token.lastUsedAt?.toISOString() ?? "never"}`);
        }
        break;
      case "token:revoke":
        if (!first) throw new AppError("VALIDATION_ERROR", "token-id is required.");
        print((await users.revokeToken(first)) ? `Revoked ${first}. Servers stop accepting it within about a minute.` : "Token not found or already revoked.");
        break;
      case "grant:add":
      case "grant:remove": {
        if (!first || !KNOWLEDGE_ID_PATTERN.test(first)) throw new AppError("VALIDATION_ERROR", "A valid knowledge-id (kn_...) is required.");
        const userId = requireIdentifier(second, "user-id");
        if (!(await documents.findById(first))) throw new AppError("NOT_FOUND", `Document ${first} does not exist.`);
        if (command === "grant:add") {
          if (!(await users.getUser(userId))) throw new AppError("NOT_FOUND", `User ${userId} does not exist.`);
          await users.ensureUser({ id: config.authUserId, displayName: config.authUserId, orgId: config.authOrgId, role: "admin", canReadPublic: true });
          await documents.addGrant(first, userId, values.write ? "write" : "read", config.authUserId);
          print(`Granted ${values.write ? "write" : "read"} access on ${first} to ${userId}.`);
        } else {
          print((await documents.removeGrant(first, userId)) ? `Removed ${userId}'s grant on ${first}.` : "No such grant.");
        }
        break;
      }
      default:
        print(`Unknown command "${command}".\n`);
        print(USAGE);
        process.exitCode = 1;
    }
  } finally {
    await db.close();
  }
}

function requireIdentifier(value: string | undefined, label: string): string {
  if (!value || !IDENTIFIER_PATTERN.test(value)) {
    throw new AppError("VALIDATION_ERROR", `${label} is required and must use lowercase letters, digits, '.', '_' or '-'.`);
  }
  return value;
}

function parseRole(value: string): Role {
  const role = ROLES.find((candidate) => candidate === value);
  if (!role) throw new AppError("VALIDATION_ERROR", `--role must be one of ${ROLES.join(", ")}.`);
  return role;
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof ConfigError ? error.message : `Error: ${errorMessage(error)}`}\n`);
  process.exitCode = 1;
});
