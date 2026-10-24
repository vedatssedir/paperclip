# Azure-only agent development platform

Status: proposal — awaiting decisions in §6 before any code is removed.

## 1. Goal

Agents do the developers' work behind Azure DevOps. Azure Boards stays the single
source of truth; the platform mirrors it 1:1, gives agents Azure Repos access, and shows
repo activity (commits, history, branches, pull requests) next to each work item.
Target: production, 10 active teams.

## 2. Current state (measured 2026-10-24)

| Area | Size (TS/JS lines) |
|---|---|
| `server/src` | ~1.21M |
| `ui/src` | ~585K |
| `packages/*` | ~605K |
| `tests` | ~117K |

Beyond the core, the repo carries chat channels (Discord, Telegram, Slack, Teams;
~62K lines in `server/src/services/chat-*`), GitHub-specific flows, a connections/app
catalog, cloud lifecycle, company portability/import, announcements, browser-use,
AgentMail, eleven agent adapters and CEO-style org/onboarding concepts. The Azure
plugin built so far (`packages/plugins/plugin-azure-devops`) bolts Azure onto this.

## 3. Target model (Azure-native)

| Azure concept | Platform concept |
|---|---|
| Organization | Instance |
| Project | Workspace (replaces "company") |
| Team (10) | Team: members → one developer agent each, area path, repos, budget |
| Work item | Task, same id, same state machine (no Paperclip status mapping) |
| Iteration / area path | Filters and board columns, read from Azure |
| Repository | Repo: clone cache, branch/commit/PR feed |
| Pull request | Agent deliverable; review and merge stay in Azure |

Removed concepts: CEO/C-suite roles, org chart, company goals, hiring flow, chat
channels, GitHub, app catalog, cloud tenancy, portability, announcements.

## 4. Architecture

```
Azure DevOps ──Service Hooks──▶ Ingest API ──▶ queue ──▶ Sync worker ──▶ Postgres
     ▲   (workitem.*, git.push, git.pullrequest.*)          │ (mirror tables)
     │                                                      ▼
     └──── REST (state, comments, PRs) ◀── Agent runner ◀── Scheduler (per team limits)
                                              │
                                     Claude Code / Codex in sandboxed workspaces
```

- **Ingest:** Service Hooks for work items, pushes and PRs, verified by secret; hourly
  reconciliation using WIQL `ChangedDate` and the Git commits/PR APIs to heal missed hooks.
- **Mirror tables:** `work_items`, `work_item_revisions`, `repositories`, `commits`,
  `pull_requests`, `pr_threads`, `teams`, `team_members`. Revision numbers make writes
  idempotent; Azure wins conflicts.
- **Auth:** an Entra ID service principal / managed identity for the server (no personal
  PATs in production); agents get short-lived, repo-scoped tokens.
- **Agent loop:** work item assigned to an agent → workspace with the item's repos →
  branch `ab/<id>-<slug>` → push → PR linked to the work item → Azure branch policies
  and human review → merge closes the item.
- **Guardrails:** per-team concurrency and monthly budget, repo allowlist, no pushes to
  protected branches, emergency stop per team, full audit log (work item ↔ run ↔
  commit ↔ PR ↔ cost).
- **Scale (10 teams):** Postgres (not embedded), queue-backed workers, Azure rate-limit
  aware client (429 / Retry-After, already implemented), horizontal agent runners.

## 5. Screens (simplified UI)

1. **Board** — Azure columns and swimlanes per team/iteration; agent avatar on cards.
2. **Work item** — Azure fields, discussion, linked commits/branches/PRs, agent runs.
3. **Repositories** — per repo: branches, commit history, open/merged PRs, agent activity.
4. **Pull requests** — cross-repo PR list with status, reviewers, policy checks.
5. **Teams & agents** — members ↔ agents, skills, budgets, pause/resume.
6. **Settings** — Azure connection, service hooks health, sync status, guardrails.

## 6. Decisions needed

1. **Approach**
   - **A. Trim this repo in place:** delete unused areas step by step, rename concepts
     to Azure ones. Keeps the mature agent runtime (heartbeats, workspaces, adapters,
     budgets), but deletions in a tightly coupled ~2.4M-line codebase are slow and risky.
   - **B. New lean app, reuse the agent runtime (recommended):** a new Azure-only
     server and UI built around the mirror model above, reusing Paperclip's adapter and
     workspace packages (`packages/adapters/claude-local`, `codex-local`,
     `packages/adapter-utils`) as libraries. Paperclip stays as the upstream source of
     those packages.
2. **Agent engines to keep:** Claude Code only, or Claude Code + Codex.
3. **Hosting:** Azure (App Service / AKS + Azure Database for PostgreSQL) or elsewhere.
4. **Designs:** Figma file to create the screens in (Figma connector must be connected).

## 7. Steps (each one shippable and verified)

1. Decisions (§6) and this plan agreed.
2. Screen designs for §5 in Figma; review.
3. Data model + Azure ingest (hooks + reconciliation) with tests against a fake Azure.
4. Board and work item screens (read-only mirror).
5. Repo activity: commits, branches, PRs.
6. Teams ↔ agents, agent loop with PRs, guardrails.
7. Remove/retire everything outside the target (approach A) or freeze the old app (B).
8. Production hardening: service principal auth, monitoring, load test with 10 teams.
