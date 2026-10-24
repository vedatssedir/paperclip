import crypto from "node:crypto";
import type { Db } from "./db/pool.js";

export interface AuthUser {
  id: string;
  email: string;
  name: string;
}

export interface Membership {
  tenantId: string;
  tenantName: string;
  role: "admin" | "member";
  azureUniqueName: string | null;
}

export function hashToken(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/** Issues a bearer token; only its hash is stored. */
export async function issueToken(db: Db, userId: string, name: string): Promise<string> {
  const token = `aza_${crypto.randomBytes(32).toString("base64url")}`;
  await db.query("INSERT INTO api_tokens (user_id, token_hash, name) VALUES ($1, $2, $3)", [userId, hashToken(token), name]);
  return token;
}

export async function authenticate(db: Db, header: string | undefined): Promise<AuthUser | null> {
  const token = header?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (!token) return null;
  const { rows } = await db.query<AuthUser>(
    `UPDATE api_tokens t SET last_used_at = now() FROM users u
      WHERE t.token_hash = $1 AND u.id = t.user_id RETURNING u.id, u.email, u.name`,
    [hashToken(token)],
  );
  return rows[0] ?? null;
}

export async function memberships(db: Db, userId: string): Promise<Membership[]> {
  const { rows } = await db.query<{ tenant_id: string; name: string; role: "admin" | "member"; azure_unique_name: string | null }>(
    `SELECT m.tenant_id, t.name, m.role, m.azure_unique_name FROM tenant_members m JOIN tenants t ON t.id = m.tenant_id
      WHERE m.user_id = $1 ORDER BY t.name`,
    [userId],
  );
  return rows.map((row) => ({ tenantId: row.tenant_id, tenantName: row.name, role: row.role, azureUniqueName: row.azure_unique_name }));
}

export function safeEqual(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
