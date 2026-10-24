import pg from "pg";

export type Db = pg.Pool;
export type Tx = pg.PoolClient;

export function createPool(connectionString: string): Db {
  return new pg.Pool({ connectionString, max: 20 });
}

/**
 * Runs `fn` in a transaction scoped to one tenant. Row-level security policies read
 * `app.tenant_id`, so every query inside sees and writes only that tenant's rows.
 */
export async function withTenant<T>(db: Db, tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function listTenantIds(db: Db): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>("SELECT id FROM tenants ORDER BY created_at");
  return rows.map((row) => row.id);
}

export async function logActivity(
  tx: Tx,
  tenantId: string,
  entry: { actor: string; action: string; entityType: string; entityId: string; details?: Record<string, unknown> },
) {
  await tx.query(
    "INSERT INTO activity (tenant_id, actor, action, entity_type, entity_id, details) VALUES ($1, $2, $3, $4, $5, $6)",
    [tenantId, entry.actor, entry.action, entry.entityType, entry.entityId, JSON.stringify(entry.details ?? {})],
  );
}
