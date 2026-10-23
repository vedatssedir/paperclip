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
