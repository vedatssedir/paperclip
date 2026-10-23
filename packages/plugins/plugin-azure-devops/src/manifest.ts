import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

export const PLUGIN_ID = "paperclip.azure-devops";
export const PLUGIN_VERSION = "0.1.0";
export const ISSUE_ORIGIN_KIND = `plugin:${PLUGIN_ID}` as const;
export const DEVELOPER_AGENT_KEY = "developer";
export const SYNC_JOB_KEY = "board-sync";
export const WORK_ITEM_WEBHOOK_KEY = "work-items";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Azure DevOps",
  description: "Syncs Azure Boards work items into Paperclip tasks and provisions one developer agent per Azure team member.",
  author: "Paperclip",
  categories: ["connector"],
  capabilities: [
    "companies.read",
    "projects.read",
    "issues.read",
    "issues.create",
    "issues.update",
    "issue.comments.create",
    "agents.read",
    "agents.managed",
    "events.subscribe",
    "jobs.schedule",
    "http.outbound",
    "secrets.read-ref",
    "plugin.state.read",
    "plugin.state.write",
    "activity.log.write",
    "instance.settings.register",
    "webhooks.receive",
    "agents.pause",
    "agents.resume",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  instanceConfigSchema: {
    type: "object",
    required: ["organizationUrl", "project", "personalAccessToken"],
    properties: {
      organizationUrl: {
        type: "string",
        title: "Organization URL",
        description: "For example https://dev.azure.com/my-org",
      },
      project: {
        type: "string",
        title: "Azure DevOps project",
      },
      personalAccessToken: {
        type: "string",
        format: "secret-ref",
        title: "Personal access token",
        description: "PAT with Work Items (Read & Write), Project and Team (Read) and Code (Read & Write) scopes. Store the same secret as AZURE_DEVOPS_PAT so agents can clone Azure Repos.",
      },
      teams: {
        type: "array",
        title: "Teams",
        description: "Azure teams to sync and provision developer agents for. Empty means every team in the project.",
        items: { type: "string" },
        default: [],
      },
      paperclipProjectId: {
        type: "string",
        title: "Paperclip project ID",
        description: "Optional project that synced tasks are created in. Its repositories become the task workspace.",
      },
      workItemQuery: {
        type: "string",
        title: "WIQL query",
        description: "Optional. Must select [System.Id]. Defaults to open work items changed in the last 30 days.",
      },
      syncEnabled: {
        type: "boolean",
        title: "Scheduled sync enabled",
        default: true,
      },
      syncIntervalMinutes: {
        type: "number",
        title: "Sync interval (minutes)",
        minimum: 1,
        default: 15,
      },
      inProgressState: {
        type: "string",
        title: "Azure state for in-progress tasks",
        default: "Active",
      },
      doneState: {
        type: "string",
        title: "Azure state for done tasks",
        default: "Closed",
      },
      defaultAgentSkills: {
        type: "array",
        title: "Default skills for new developer agents",
        description: "Company skill keys assigned when a developer agent is created. Skills can be changed later on each agent.",
        items: { type: "string" },
        default: [],
      },
      webhookSecret: {
        type: "string",
        format: "secret-ref",
        title: "Webhook secret",
        description: "Shared secret for Azure DevOps Service Hooks (work item created/updated). Send it as the basic auth password or an X-Paperclip-Webhook-Secret header.",
      },
      allowedRepositories: {
        type: "array",
        title: "Allowed repositories",
        description: "Azure Repos names agents may work on. When set, other repo: tags are dropped from tasks.",
        items: { type: "string" },
        default: [],
      },
      maxWorkItemsPerSync: {
        type: "number",
        title: "Max work items per sync",
        minimum: 1,
        default: 500,
      },
      maxNewTasksPerSync: {
        type: "number",
        title: "Max new tasks per sync",
        minimum: 1,
        default: 25,
      },
      agentMonthlyBudgetCents: {
        type: "number",
        title: "Developer agent monthly budget (cents)",
        description: "Applied when a developer agent is created. Empty keeps the declaration default.",
        minimum: 0,
      },
      requireTriage: {
        type: "boolean",
        title: "Require triage",
        description: "New tasks without an Azure assignee land in backlog unassigned.",
        default: true,
      },
    },
  },
  jobs: [
    {
      jobKey: SYNC_JOB_KEY,
      displayName: "Azure Boards sync",
      description: "Runs every minute and syncs each company whose configured interval has elapsed.",
      schedule: "* * * * *",
    },
  ],
  webhooks: [
    {
      endpointKey: WORK_ITEM_WEBHOOK_KEY,
      displayName: "Azure Boards work items",
      description: "Azure DevOps Service Hooks target for workitem.created and workitem.updated events.",
    },
  ],
  agents: [
    {
      agentKey: DEVELOPER_AGENT_KEY,
      multiInstance: true,
      displayName: "Azure Developer",
      role: "engineer",
      title: "Developer",
      icon: "code",
      capabilities: "Implements Azure Boards work items in the project's Azure Repos repositories.",
      adapterType: "claude_local",
      adapterPreference: ["claude_local", "codex_local", "gemini_local", "opencode_local", "cursor", "pi_local"],
      status: "idle",
      budgetMonthlyCents: 0,
      instructions: {
        entryFile: "AGENTS.md",
        content: [
          "# Azure Developer",
          "",
          "You implement tasks synced from Azure Boards.",
          "",
          "- The task description links the Azure work item and lists the repositories to change.",
          "- Work in the task workspace checkouts. Azure Repos authenticate through the company AZURE_DEVOPS_PAT secret.",
          "- Commit on a branch named after the task, push it, and summarize the change in a task comment.",
          "- Move the task to in_review when the change is pushed. Paperclip syncs the status back to Azure.",
          "",
        ].join("\n"),
      },
    },
  ],
  ui: {
    slots: [
      {
        type: "companySettingsPage",
        id: "azure-devops-settings",
        displayName: "Azure DevOps",
        exportName: "AzureDevOpsSettingsPage",
        routePath: "azure-devops",
      },
    ],
  },
};

export default manifest;
