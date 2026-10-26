import type { QueryResultRow } from "pg";
import { generateApiToken } from "../../security/authentication.js";
import type { Identity, Role } from "../../types/domain.js";
import { AppError } from "../../utils/errors.js";
import { SqlParams } from "../../utils/sql.js";
import { firstRow, pgErrorCode, type Queryable } from "../client.js";

export interface NewUser {
  id: string;
  displayName: string;
  orgId: string;
  role: Role;
  canReadPublic: boolean;
}

export interface UserRecord extends NewUser {
  isActive: boolean;
  createdAt: Date;
}

export interface UserChanges {
  displayName?: string;
  role?: Role;
  canReadPublic?: boolean;
  isActive?: boolean;
}

export interface TokenRecord {
  id: string;
  userId: string;
  label: string | null;
  createdAt: Date;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

interface UserRow extends QueryResultRow {
  id: string;
  display_name: string;
  org_id: string;
  role: Role;
  can_read_public: boolean;
  is_active: boolean;
  created_at: Date;
}

interface IdentityRow extends QueryResultRow {
  id: string;
  org_id: string;
  role: Role;
  can_read_public: boolean;
  token_id: string;
}

interface TokenRow extends QueryResultRow {
  id: string;
  user_id: string;
  label: string | null;
  created_at: Date;
  expires_at: Date | null;
  last_used_at: Date | null;
  revoked_at: Date | null;
}

const USER_COLUMNS = "id, display_name, org_id, role, can_read_public, is_active, created_at";

/** Users and API tokens. Tokens are stored only as SHA-256 hashes. */
export class UserRepository {
  constructor(private readonly db: Queryable) {}

  async ensureUser(user: NewUser): Promise<void> {
    await this.db.query(
      `INSERT INTO users (id, display_name, org_id, role, can_read_public)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO NOTHING`,
      [user.id, user.displayName, user.orgId, user.role, user.canReadPublic],
    );
  }

  async createUser(user: NewUser): Promise<UserRecord> {
    try {
      const result = await this.db.query<UserRow>(
        `INSERT INTO users (id, display_name, org_id, role, can_read_public)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING ${USER_COLUMNS}`,
        [user.id, user.displayName, user.orgId, user.role, user.canReadPublic],
      );
      return mapUser(firstRow(result.rows));
    } catch (error) {
      const code = pgErrorCode(error);
      if (code === "23505") throw new AppError("CONFLICT", `User "${user.id}" already exists.`);
      if (code === "23514") {
        throw new AppError("VALIDATION_ERROR", "User and organization ids must use lowercase letters, digits, '.', '_' or '-'.");
      }
      throw error;
    }
  }

  async getUser(id: string): Promise<UserRecord | null> {
    const result = await this.db.query<UserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [id]);
    const row = result.rows[0];
    return row ? mapUser(row) : null;
  }

  async listUsers(): Promise<UserRecord[]> {
    const result = await this.db.query<UserRow>(`SELECT ${USER_COLUMNS} FROM users ORDER BY org_id, id`);
    return result.rows.map(mapUser);
  }

  async updateUser(id: string, changes: UserChanges): Promise<UserRecord | null> {
    const params = new SqlParams();
    const sets: string[] = [];
    if (changes.displayName !== undefined) sets.push(`display_name = ${params.add(changes.displayName)}`);
    if (changes.role !== undefined) sets.push(`role = ${params.add(changes.role)}`);
    if (changes.canReadPublic !== undefined) sets.push(`can_read_public = ${params.add(changes.canReadPublic)}`);
    if (changes.isActive !== undefined) sets.push(`is_active = ${params.add(changes.isActive)}`);
    if (sets.length === 0) return this.getUser(id);
    const idParam = params.add(id);
    const result = await this.db.query<UserRow>(
      `UPDATE users SET ${sets.join(", ")}, updated_at = now() WHERE id = ${idParam} RETURNING ${USER_COLUMNS}`,
      params.values,
    );
    const row = result.rows[0];
    return row ? mapUser(row) : null;
  }

  /** Resolves an active, unexpired, unrevoked token; refreshes last_used_at at most every 5 minutes. */
  async findIdentityByTokenHash(tokenHash: string): Promise<Identity | null> {
    const result = await this.db.query<IdentityRow>(
      `WITH token AS (
         SELECT id, user_id FROM api_tokens
         WHERE token_hash = $1
           AND revoked_at IS NULL
           AND (expires_at IS NULL OR expires_at > now())
       ), touched AS (
         UPDATE api_tokens SET last_used_at = now()
         WHERE id IN (SELECT id FROM token)
           AND (last_used_at IS NULL OR last_used_at < now() - interval '5 minutes')
       )
       SELECT u.id, u.org_id, u.role, u.can_read_public, token.id AS token_id
       FROM token JOIN users u ON u.id = token.user_id
       WHERE u.is_active`,
      [tokenHash],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      userId: row.id,
      orgId: row.org_id,
      role: row.role,
      canReadPublic: row.can_read_public,
      authMethod: "api_token",
      tokenId: row.token_id,
    };
  }

  async createToken(
    userId: string,
    options: { label?: string; expiresAt?: Date | null } = {},
  ): Promise<{ token: string; tokenId: string; expiresAt: Date | null }> {
    const user = await this.getUser(userId);
    if (!user) throw new AppError("NOT_FOUND", `User "${userId}" does not exist.`);
    if (!user.isActive) throw new AppError("FORBIDDEN", `User "${userId}" is disabled.`);
    const { token, tokenId, tokenHash } = generateApiToken();
    const expiresAt = options.expiresAt ?? null;
    await this.db.query(
      `INSERT INTO api_tokens (id, user_id, token_hash, label, expires_at) VALUES ($1, $2, $3, $4, $5)`,
      [tokenId, userId, tokenHash, options.label ?? null, expiresAt],
    );
    return { token, tokenId, expiresAt };
  }

  async revokeToken(tokenId: string): Promise<boolean> {
    const result = await this.db.query(
      "UPDATE api_tokens SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL",
      [tokenId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async listTokens(userId: string): Promise<TokenRecord[]> {
    const result = await this.db.query<TokenRow>(
      `SELECT id, user_id, label, created_at, expires_at, last_used_at, revoked_at
       FROM api_tokens WHERE user_id = $1 ORDER BY created_at DESC`,
      [userId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      label: row.label,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      lastUsedAt: row.last_used_at,
      revokedAt: row.revoked_at,
    }));
  }
}

function mapUser(row: UserRow): UserRecord {
  return {
    id: row.id,
    displayName: row.display_name,
    orgId: row.org_id,
    role: row.role,
    canReadPublic: row.can_read_public,
    isActive: row.is_active,
    createdAt: row.created_at,
  };
}
