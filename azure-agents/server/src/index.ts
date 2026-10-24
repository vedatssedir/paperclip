import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import fastifyStatic from "@fastify/static";
import { loadConfig } from "./config.js";
import { createPool, listTenantIds } from "./db/pool.js";
import { migrate } from "./db/migrate.js";
import { createSecretStore } from "./secrets.js";
import { buildApp } from "./http/app.js";
import { syncTenant } from "./sync/sync.js";
import { runQueuedOnce } from "./agents/runner.js";

const config = loadConfig();
const db = createPool(config.databaseUrl);
await migrate(db);
const secrets = createSecretStore(config.secretsKey);
const app = buildApp({ db, secrets });

const uiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../ui/dist");
if (fs.existsSync(uiDir)) {
  await app.register(fastifyStatic, { root: uiDir });
  app.setNotFoundHandler((request, reply) =>
    request.url.startsWith("/api/") ? reply.status(404).send({ error: "Not found" }) : reply.sendFile("index.html"));
}

/** Runs `task` every `ms`, never overlapping with itself. */
function every(ms: number, name: string, task: () => Promise<unknown>) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await task(); } catch (error) { console.error(`${name} failed`, error); } finally { running = false; }
  };
  setInterval(tick, ms).unref();
  void tick();
}

every(config.syncIntervalSeconds * 1000, "sync", async () => {
  for (const tenantId of await listTenantIds(db)) await syncTenant({ db, secrets }, tenantId).catch((error) => console.error(`sync ${tenantId}`, error.message));
});
if (config.runnerConcurrency > 0) {
  every(10_000, "runner", () => runQueuedOnce({ db, secrets, workspaceRoot: config.workspaceRoot, timeoutMs: config.runTimeoutMs }, config.runnerConcurrency));
}

await app.listen({ port: config.port, host: "0.0.0.0" });
console.log(`azure-agents listening on ${config.publicUrl}`);
