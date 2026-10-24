import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  // 32-byte key, base64. Encrypts tenant secrets (PATs, provider API keys) at rest.
  SECRETS_KEY: z.string().refine((value) => Buffer.from(value, "base64").length === 32, "SECRETS_KEY must be 32 bytes, base64"),
  PORT: z.coerce.number().int().default(3200),
  PUBLIC_URL: z.string().url().default("http://localhost:3200"),
  WORKSPACE_ROOT: z.string().default("/var/lib/azure-agents/workspaces"),
  SYNC_INTERVAL_SECONDS: z.coerce.number().int().min(30).default(300),
  RUNNER_CONCURRENCY: z.coerce.number().int().min(0).default(4),
  RUN_TIMEOUT_MINUTES: z.coerce.number().int().min(1).default(45),
});

export type Config = {
  databaseUrl: string;
  secretsKey: Buffer;
  port: number;
  publicUrl: string;
  workspaceRoot: string;
  syncIntervalSeconds: number;
  runnerConcurrency: number;
  runTimeoutMs: number;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.parse(env);
  return {
    databaseUrl: parsed.DATABASE_URL,
    secretsKey: Buffer.from(parsed.SECRETS_KEY, "base64"),
    port: parsed.PORT,
    publicUrl: parsed.PUBLIC_URL,
    workspaceRoot: parsed.WORKSPACE_ROOT,
    syncIntervalSeconds: parsed.SYNC_INTERVAL_SECONDS,
    runnerConcurrency: parsed.RUNNER_CONCURRENCY,
    runTimeoutMs: parsed.RUN_TIMEOUT_MINUTES * 60_000,
  };
}
