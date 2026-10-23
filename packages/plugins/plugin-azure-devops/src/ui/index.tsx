import { useState } from "react";
import {
  ActionBar,
  KeyValueList,
  Spinner,
  usePluginAction,
  usePluginData,
  usePluginToast,
  type PluginCompanySettingsPageProps,
} from "@paperclipai/plugin-sdk/ui";

interface StatusData {
  configured: boolean;
  syncEnabled: boolean;
  syncIntervalMinutes: number | null;
  board: { lastSyncAt: string | null; trigger: string | null; created: number; updated: number; error: string | null } | null;
  agents: { syncedAt: string; teams: string[]; agents: Array<{ uniqueName: string; status: string }> } | null;
}

interface ConnectionTestResult {
  ok: boolean;
  checks: Array<{ name: string; ok: boolean; detail: string }>;
  project: { id: string; name: string } | null;
  teams: Array<{ id: string; name: string }>;
  repositories: Array<{ id: string; name: string; defaultBranch: string | null }>;
}

function ConnectionTest({ companyId }: { companyId: string }) {
  const testConnection = usePluginAction("test-connection");
  const [result, setResult] = useState<ConnectionTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  async function run() {
    setRunning(true);
    setError(null);
    try {
      setResult((await testConnection({ companyId })) as ConnectionTestResult);
    } catch (caught) {
      setResult(null);
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setRunning(false);
    }
  }

  return (
    <section aria-label="Connection test" style={{ display: "grid", gap: "0.5rem" }}>
      <div>
        <button type="button" onClick={run} disabled={running}>
          {running ? "Testing connection..." : "Test connection"}
        </button>
      </div>
      {error ? <p role="alert">{error}</p> : null}
      {result ? (
        <KeyValueList
          pairs={[
            { label: "Result", value: result.ok ? "Connection OK" : "Connection failed" },
            ...result.checks.map((check) => ({ label: check.name, value: `${check.ok ? "OK" : "Failed"} · ${check.detail}` })),
            ...(result.teams.length ? [{ label: "Teams found", value: result.teams.map((team) => team.name).join(", ") }] : []),
            ...(result.repositories.length
              ? [{ label: "Repositories found", value: result.repositories.map((repo) => repo.name).join(", ") }]
              : []),
          ]}
        />
      ) : null}
    </section>
  );
}

export function AzureDevOpsSettingsPage({ context }: PluginCompanySettingsPageProps) {
  const companyId = context.companyId;
  const status = usePluginData<StatusData>("status", companyId ? { companyId } : {});
  const toast = usePluginToast();
  if (!companyId) return null;
  if (status.loading && !status.data) return <Spinner />;
  const data = status.data;

  return (
    <div style={{ display: "grid", gap: "1rem" }}>
      <p>
        Set the organization URL, project, personal access token and teams in the configuration form above, save, then test the connection.
        Add the same token as the <code>AZURE_DEVOPS_PAT</code> company secret so agents can clone Azure Repos.
      </p>
      {status.error ? <p role="alert">{status.error.message}</p> : null}
      <KeyValueList
        pairs={[
          { label: "Configured", value: data?.configured ? "Yes" : "No" },
          { label: "Scheduled sync", value: data?.syncEnabled ? `Every ${data.syncIntervalMinutes} min` : "Off" },
          { label: "Last board sync", value: data?.board?.lastSyncAt ?? "Never" },
          { label: "Last result", value: data?.board ? (data.board.error ?? `${data.board.created} created, ${data.board.updated} updated`) : "—" },
          { label: "Developer agents", value: data?.agents ? `${data.agents.agents.length} (${data.agents.teams.join(", ")})` : "Not synced" },
        ]}
      />
      <ConnectionTest companyId={companyId} />
      <ActionBar
        actions={[
          { label: "Sync board now", actionKey: "sync-now", params: { companyId } },
          { label: "Sync team developer agents", actionKey: "sync-agents", params: { companyId } },
        ]}
        onSuccess={() => status.refresh()}
        onError={(_key, error) => {
          toast({ title: "Azure DevOps action failed", body: error instanceof Error ? error.message : String(error), tone: "error" });
          status.refresh();
        }}
      />
    </div>
  );
}
