# Azure DevOps plugin

Connects a Paperclip company to one Azure DevOps project:

- **Board sync** – Azure Boards work items become Paperclip tasks (`[AB#123] Title`).
  Azure owns title and description; a task is closed or cancelled when its work item is.
  Paperclip `in_progress` / `done` statuses are written back to the work item, and moving
  to `in_review` or `done` adds a work item comment.
- **Schedule** – a plugin job runs every minute and syncs each company whose
  *Sync interval (minutes)* has elapsed. Change the interval or turn scheduled sync off at
  any time in settings; **Sync board now** runs it manually.
- **Developer agents** – **Sync team developer agents** creates one `engineer` agent per
  member of the configured Azure teams (all teams when empty). Re-running is idempotent.
  Work items assigned to a member are assigned to that member's agent. New agents get the
  *Default skills*; manage skills per agent afterwards on the agent's Skills tab.
- **Repositories** – tag a work item `repo:<name>` to list Azure Repos in the task
  description. Add those repositories to the Paperclip project as workspaces with their
  `https://dev.azure.com/{org}/{project}/_git/{repo}` URL. Git authenticates against
  `dev.azure.com` / `*.visualstudio.com` with the `AZURE_DEVOPS_PAT` company secret.

## Sync reliability

- Azure requests retry up to 3 times on HTTP 429/503, honoring `Retry-After`.
- *Max work items per sync* (default 500) caps one sync; ids are fetched in 200-item batches.
- Incremental sync: with the default WIQL query, syncs after the first add
  `[System.ChangedDate] >= '<day of last complete sync>'` (WIQL date precision is one day).
  The watermark only advances when no item was truncated or deferred. Custom queries run as written.
- **Webhook** – point an Azure DevOps Service Hook (Web Hooks, `Work item created` /
  `Work item updated`) at the plugin's `work-items` webhook URL. Set *Webhook secret* and
  send it as the basic auth password or an `X-Paperclip-Webhook-Secret` header. Valid
  deliveries sync that single work item; invalid ones are rejected.

## Guardrails

- *Allowed repositories*: when set, `repo:` tags outside the list are dropped from the
  task and noted as not allowed.
- *Max new tasks per sync* (default 25): further new work items wait for the next sync.
- *Require triage* (default on): new tasks land in `backlog` unassigned unless the Azure
  work item is assigned to a member with a developer agent.
- *Developer agent monthly budget (cents)*: applied when developer agents are created.
- Actions `pause-all-agents` / `resume-all-agents` pause or resume every developer agent
  this plugin manages in the company.

## Setup

1. Create a PAT with Work Items (Read & Write), Project and Team (Read) and Code (Read & Write).
2. In **Settings → Secrets**, add it as `AZURE_DEVOPS_PAT`.
3. Build and install the plugin:

   ```sh
   pnpm --filter @paperclipai/plugin-azure-devops build
   paperclipai plugin install ./packages/plugins/plugin-azure-devops
   ```

4. Open the plugin settings, fill in organization URL, project and teams, pick the
   `AZURE_DEVOPS_PAT` secret as the personal access token, and optionally a target
   Paperclip project ID.
5. Use **Company settings → Azure DevOps** to sync agents and the board.

No CEO agent is needed: companies can run with only these developer agents.

## Pull requests and connection test

- The configuration form is shown on the company settings **Azure DevOps** page
  (and still on the instance plugin settings page). Use **Test connection** there
  to check the PAT, project access, teams and repositories.
- Developer agents open PRs with the `azure_create_pull_request` tool
  (`issueId`, `repository`, `sourceBranch`, optional `targetBranch`/`title`/`description`).
  The PR targets the repository default branch by default, is linked to the
  task's work item, and its URL is commented on the task. PRs from the default
  branch are refused.
- The `pr-status` job (every 5 minutes) marks the task `done` once its PR is
  completed, and comments when a PR is abandoned.

## Testing against a real Azure DevOps organization

1. Sign up at https://dev.azure.com (free for up to 5 users) and create an organization.
2. Create a private project with **Git** and the **Agile** process. Initialize the default
   repo and add a second one (for example `api`). Add a branch policy on `main` that
   requires a reviewer so agents can only land changes through pull requests.
3. Add team members under Organization settings → Users and Project settings → Teams.
4. Create a PAT (user menu → Personal access tokens) with Work Items (Read & write),
   Code (Read & write) and Project and Team (Read). Save it as the `AZURE_DEVOPS_PAT`
   company secret.
5. Configure the plugin on **Company settings → Azure DevOps**, then run, in order:
   **Test connection**, **Sync team developer agents**, and **Sync board now** after
   creating a work item tagged `repo:api` and assigned to a team member.
6. Expected: an `[AB#n]` task assigned to that member's agent; moving it to
   `in_progress` sets the work item to Active; the agent's pull request is linked to the
   work item; merging it marks the task done.
7. Optional: add a Service Hook (Web Hooks, "Work item created/updated") pointing at the
   plugin's `work-items` webhook URL with the configured webhook secret. Azure must be
   able to reach your Paperclip URL, for example through a tunnel.

`tests/scenario.spec.ts` runs this flow against an in-memory fake of the Azure REST API.
