import crypto from "node:crypto";
import type { Tx } from "./db/pool.js";

/** Well-known tenant secret names. */
export const SECRET = {
  azurePat: "AZURE_DEVOPS_PAT",
  webhookSecret: "AZURE_WEBHOOK_SECRET",
  anthropicKey: "ANTHROPIC_API_KEY",
  openaiKey: "OPENAI_API_KEY",
  geminiKey: "GEMINI_API_KEY",
} as const;

export function createSecretStore(key: Buffer) {
  return {
    async set(tx: Tx, tenantId: string, name: string, value: string) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
      const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      await tx.query(
        `INSERT INTO secrets (tenant_id, name, ciphertext, iv, tag) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (tenant_id, name) DO UPDATE SET ciphertext = EXCLUDED.ciphertext, iv = EXCLUDED.iv,
           tag = EXCLUDED.tag, updated_at = now()`,
        [tenantId, name, ciphertext, iv, cipher.getAuthTag()],
      );
    },

    async get(tx: Tx, name: string): Promise<string | null> {
      const { rows } = await tx.query<{ ciphertext: Buffer; iv: Buffer; tag: Buffer }>(
        "SELECT ciphertext, iv, tag FROM secrets WHERE name = $1",
        [name],
      );
      const row = rows[0];
      if (!row) return null;
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, row.iv);
      decipher.setAuthTag(row.tag);
      return Buffer.concat([decipher.update(row.ciphertext), decipher.final()]).toString("utf8");
    },

    /** Names only — values never leave the server. */
    async list(tx: Tx): Promise<Array<{ name: string; updatedAt: string }>> {
      const { rows } = await tx.query<{ name: string; updated_at: Date }>("SELECT name, updated_at FROM secrets ORDER BY name");
      return rows.map((row) => ({ name: row.name, updatedAt: row.updated_at.toISOString() }));
    },

    async remove(tx: Tx, name: string) {
      await tx.query("DELETE FROM secrets WHERE name = $1", [name]);
    },
  };
}

export type SecretStore = ReturnType<typeof createSecretStore>;
