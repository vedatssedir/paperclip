import type { Db, Tx } from "../db/pool.js";
import { logActivity, withTenant } from "../db/pool.js";
import { createAzureClient, type AzureClient, type AzureWorkItem, type Fetch } from "../azure/client.js";
import { reconciliationQuery, stripRefs, toWorkItemRow } from "../azure/mapping.js";
import { SECRET, type SecretStore } from "../secrets.js";
import { queueAssignedWork } from "../agents/dispatch.js";

export interface SyncDeps {
  db: Db;
  secrets: SecretStore;
  fetch?: Fetch;
}

export interface SyncResult {
  teams: number;
  repositories: number;
  workItems: number;
  commits: number;
  pullRequests: number;
  queuedRuns: number;
}

export async function azureClientFor(tx: Tx, deps: SyncDeps): Promise<{ client: AzureClient; lastSyncAt: Date | null } | null> {
  const { rows } = await tx.query<{ organization_url: string; project: string; last_sync_at: Date | null }>(
    "SELECT organization_url, project, last_sync_at FROM azure_connections",
  );
  const connection = rows[0];
  if (!connection) return null;
  const pat = await deps.secrets.get(tx, SECRET.azurePat);
  if (!pat) throw new Error(`Secret ${SECRET.azurePat} is not set`);
  return {
    client: createAzureClient({ organizationUrl: connection.organization_url, project: connection.project, pat, fetch: deps.fetch }),
    lastSyncAt: connection.last_sync_at,
  };
}

export async function upsertWorkItems(tx: Tx, tenantId: string, client: AzureClient, items: AzureWorkItem[]): Promise<number> {
  let changed = 0;
  for (const item of items) {
    const row = toWorkItemRow(item);
    const result = await tx.query(
      `INSERT INTO work_items (tenant_id, azure_id, rev, type, title, state, assigned_to_unique_name,
         assigned_to_display_name, area_path, iteration_path, priority, tags, repo_names, description_html, web_url, changed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT (tenant_id, azure_id) DO UPDATE SET rev = EXCLUDED.rev, type = EXCLUDED.type, title = EXCLUDED.title,
         state = EXCLUDED.state, assigned_to_unique_name = EXCLUDED.assigned_to_unique_name,
         assigned_to_display_name = EXCLUDED.assigned_to_display_name, area_path = EXCLUDED.area_path,
         iteration_path = EXCLUDED.iteration_path, priority = EXCLUDED.priority, tags = EXCLUDED.tags,
         repo_names = EXCLUDED.repo_names, description_html = EXCLUDED.description_html, changed_at = EXCLUDED.changed_at
       WHERE work_items.rev < EXCLUDED.rev`,
      [tenantId, row.azureId, row.rev, row.type, row.title, row.state, row.assignedToUniqueName, row.assignedToDisplayName,
        row.areaPath, row.iterationPath, row.priority, row.tags, row.repoNames, row.descriptionHtml,
        client.workItemWebUrl(row.azureId), row.changedAt],
    );
    changed += result.rowCount ?? 0;
  }
  return changed;
}

async function syncTeams(tx: Tx, tenantId: string, client: AzureClient): Promise<number> {
  const teams = await client.listTeams();
  for (const team of teams) {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO teams (tenant_id, azure_id, name) VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, azure_id) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      [tenantId, team.id, team.name],
    );
    const teamId = rows[0]!.id;
    const members = await client.listTeamMembers(team.id);
    await tx.query("DELETE FROM team_members WHERE team_id = $1 AND NOT (unique_name = ANY($2))",
      [teamId, members.map((member) => member.uniqueName.toLowerCase())]);
    for (const member of members) {
      await tx.query(
        `INSERT INTO team_members (tenant_id, team_id, unique_name, display_name) VALUES ($1, $2, $3, $4)
         ON CONFLICT (team_id, unique_name) DO UPDATE SET display_name = EXCLUDED.display_name`,
        [tenantId, teamId, member.uniqueName.toLowerCase(), member.displayName],
      );
    }
  }
  return teams.length;
}

async function syncRepositories(tx: Tx, tenantId: string, client: AzureClient, since: Date | null) {
  const repos = await client.listRepositories();
  let commits = 0;
  let pullRequests = 0;
  const commitsSince = since ?? new Date(Date.now() - 30 * 86_400_000);
  for (const repo of repos) {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO repositories (tenant_id, azure_id, name, default_branch, remote_url, web_url) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (tenant_id, azure_id) DO UPDATE SET name = EXCLUDED.name, default_branch = EXCLUDED.default_branch,
         remote_url = EXCLUDED.remote_url, web_url = EXCLUDED.web_url RETURNING id`,
      [tenantId, repo.id, repo.name, repo.defaultBranch ? stripRefs(repo.defaultBranch) : null, repo.remoteUrl, repo.webUrl],
    );
    const repositoryId = rows[0]!.id;
    // Empty repositories have no default branch and reject commit queries.
    if (!repo.defaultBranch) continue;

    for (const commit of await client.listCommits(repo.name, commitsSince)) {
      const result = await tx.query(
        `INSERT INTO commits (tenant_id, repository_id, commit_id, author_name, author_email, message, committed_at, web_url)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
        [tenantId, repositoryId, commit.commitId, commit.author.name, commit.author.email ?? null, commit.comment,
          new Date(commit.author.date), `${repo.webUrl}/commit/${commit.commitId}`],
      );
      commits += result.rowCount ?? 0;
    }

    for (const pr of await client.listPullRequests(repo.name)) {
      const existing = await tx.query<{ status: string }>(
        "SELECT status FROM pull_requests WHERE repository_id = $1 AND azure_pr_id = $2", [repositoryId, pr.pullRequestId]);
      if (existing.rows[0]?.status === pr.status) continue;
      const workItemIds = await client.getPullRequestWorkItemIds(repo.name, pr.pullRequestId);
      await tx.query(
        `INSERT INTO pull_requests (tenant_id, repository_id, azure_pr_id, title, status, source_branch, target_branch,
           created_by, created_at, closed_at, web_url, work_item_azure_ids)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (repository_id, azure_pr_id) DO UPDATE SET title = EXCLUDED.title, status = EXCLUDED.status,
           closed_at = EXCLUDED.closed_at, work_item_azure_ids = EXCLUDED.work_item_azure_ids`,
        [tenantId, repositoryId, pr.pullRequestId, pr.title, pr.status, stripRefs(pr.sourceRefName), stripRefs(pr.targetRefName),
          pr.createdBy.displayName, new Date(pr.creationDate), pr.closedDate ? new Date(pr.closedDate) : null,
          client.pullRequestWebUrl(repo.webUrl, pr.pullRequestId), workItemIds],
      );
      pullRequests += 1;
    }
  }
  return { repositories: repos.length, commits, pullRequests };
}

/** Full reconciliation for one tenant: teams, repos (commits, PRs), work items, then dispatch. */
export async function syncTenant(deps: SyncDeps, tenantId: string): Promise<SyncResult | null> {
  const startedAt = new Date();
  try {
    return await withTenant(deps.db, tenantId, async (tx) => {
      const connection = await azureClientFor(tx, deps);
      if (!connection) return null;
      const { client, lastSyncAt } = connection;
      const teams = await syncTeams(tx, tenantId, client);
      const repoStats = await syncRepositories(tx, tenantId, client, lastSyncAt);
      const ids = await client.queryWorkItemIds(reconciliationQuery(lastSyncAt));
      const workItems = await upsertWorkItems(tx, tenantId, client, await client.getWorkItems(ids));
      const queuedRuns = await queueAssignedWork(tx, tenantId);
      await tx.query("UPDATE azure_connections SET last_sync_at = $1, last_sync_error = NULL", [startedAt]);
      const result = { teams, ...repoStats, workItems, queuedRuns };
      await logActivity(tx, tenantId, { actor: "sync", action: "sync.completed", entityType: "tenant", entityId: tenantId, details: { ...result } });
      return result;
    });
  } catch (error) {
    // The sync transaction rolled back; record the failure in its own transaction.
    await withTenant(deps.db, tenantId, (tx) =>
      tx.query("UPDATE azure_connections SET last_sync_error = $1", [(error as Error).message])).catch(() => undefined);
    throw error;
  }
}

/** Service-hook path: refresh one work item and dispatch. */
export async function syncWorkItem(deps: SyncDeps, tenantId: string, azureId: number): Promise<void> {
  await withTenant(deps.db, tenantId, async (tx) => {
    const connection = await azureClientFor(tx, deps);
    if (!connection) return;
    await upsertWorkItems(tx, tenantId, connection.client, await connection.client.getWorkItems([azureId]));
    await queueAssignedWork(tx, tenantId);
  });
}
