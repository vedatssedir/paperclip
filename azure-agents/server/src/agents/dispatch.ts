import type { Tx } from "../db/pool.js";
import { logActivity } from "../db/pool.js";
import { CLOSED_STATES } from "../azure/mapping.js";

/**
 * Developers assign work items to themselves in Azure; each developer is paired with one
 * agent. Every open item assigned to a paired developer gets one run, unless it already
 * has an active or successful run. Failed runs are retried from the UI.
 */
export async function queueAssignedWork(tx: Tx, tenantId: string): Promise<number> {
  const { rows } = await tx.query<{ work_item_id: string; agent_id: string; azure_id: number }>(
    `INSERT INTO agent_runs (tenant_id, agent_id, work_item_id, status)
     SELECT wi.tenant_id, a.id, wi.id, 'queued'
       FROM work_items wi
       JOIN agents a ON a.paired_unique_name = wi.assigned_to_unique_name AND a.enabled
      WHERE NOT (wi.state = ANY($1))
        AND NOT EXISTS (
          SELECT 1 FROM agent_runs r
           WHERE r.work_item_id = wi.id AND r.status IN ('queued', 'running', 'succeeded'))
     ON CONFLICT DO NOTHING
     RETURNING work_item_id, agent_id, (SELECT azure_id FROM work_items WHERE id = work_item_id) AS azure_id`,
    [CLOSED_STATES],
  );
  for (const row of rows) {
    await logActivity(tx, tenantId, {
      actor: "dispatch", action: "run.queued", entityType: "work_item", entityId: String(row.azure_id),
      details: { agentId: row.agent_id },
    });
  }
  return rows.length;
}
