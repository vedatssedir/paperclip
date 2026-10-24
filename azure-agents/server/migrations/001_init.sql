-- Multi-tenant schema. Every tenant-owned table carries tenant_id and is protected by
-- row-level security keyed on the `app.tenant_id` setting, which the server sets per
-- transaction (see server/src/db/pool.ts). The app role must not be a superuser.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Global tables (no tenant scope) -------------------------------------------------

CREATE TABLE tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE api_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);

-- Membership is read before a tenant is selected, so it is filtered in code, not RLS.
CREATE TABLE tenant_members (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('admin', 'member')),
  -- Azure DevOps identity (uniqueName, usually the e-mail) of this developer.
  azure_unique_name text,
  PRIMARY KEY (tenant_id, user_id),
  UNIQUE (tenant_id, azure_unique_name)
);

-- Tenant tables ------------------------------------------------------------------

CREATE TABLE secrets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  ciphertext bytea NOT NULL,
  iv bytea NOT NULL,
  tag bytea NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

CREATE TABLE azure_connections (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  organization_url text NOT NULL,
  project text NOT NULL,
  -- Work item state written when an agent opens a pull request (null = leave state).
  review_state text,
  last_sync_at timestamptz,
  last_sync_error text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE teams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  azure_id text NOT NULL,
  name text NOT NULL,
  UNIQUE (tenant_id, azure_id)
);

CREATE TABLE team_members (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  unique_name text NOT NULL,
  display_name text NOT NULL,
  PRIMARY KEY (team_id, unique_name)
);

CREATE TABLE agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  provider text NOT NULL CHECK (provider IN ('claude', 'openai', 'gemini')),
  model text,
  instructions text NOT NULL DEFAULT '',
  -- Work items assigned to this Azure identity are handed to this agent.
  paired_unique_name text,
  team_id uuid REFERENCES teams(id) ON DELETE SET NULL,
  max_concurrent_runs integer NOT NULL DEFAULT 1 CHECK (max_concurrent_runs BETWEEN 1 AND 10),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, paired_unique_name)
);

CREATE TABLE skills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key text NOT NULL CHECK (key ~ '^[a-z0-9][a-z0-9-]*$'),
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  content text NOT NULL,
  UNIQUE (tenant_id, key)
);

CREATE TABLE mcp_servers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (name ~ '^[a-z0-9][a-z0-9_-]*$'),
  transport text NOT NULL CHECK (transport IN ('stdio', 'http')),
  command text,
  args jsonb NOT NULL DEFAULT '[]',
  url text,
  -- Names of tenant secrets exposed to the server as environment variables.
  env_secret_names jsonb NOT NULL DEFAULT '[]',
  UNIQUE (tenant_id, name),
  CHECK ((transport = 'stdio' AND command IS NOT NULL) OR (transport = 'http' AND url IS NOT NULL))
);

CREATE TABLE agent_skills (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  skill_id uuid NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  PRIMARY KEY (agent_id, skill_id)
);

CREATE TABLE agent_mcp_servers (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  mcp_server_id uuid NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
  PRIMARY KEY (agent_id, mcp_server_id)
);

CREATE TABLE repositories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  azure_id text NOT NULL,
  name text NOT NULL,
  default_branch text,
  remote_url text NOT NULL,
  web_url text NOT NULL,
  UNIQUE (tenant_id, azure_id),
  UNIQUE (tenant_id, name)
);

CREATE TABLE work_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  azure_id integer NOT NULL,
  rev integer NOT NULL,
  type text NOT NULL,
  title text NOT NULL,
  state text NOT NULL,
  assigned_to_unique_name text,
  assigned_to_display_name text,
  area_path text,
  iteration_path text,
  priority integer,
  tags text[] NOT NULL DEFAULT '{}',
  repo_names text[] NOT NULL DEFAULT '{}',
  description_html text NOT NULL DEFAULT '',
  web_url text NOT NULL,
  changed_at timestamptz NOT NULL,
  UNIQUE (tenant_id, azure_id)
);
CREATE INDEX work_items_assignee ON work_items (tenant_id, assigned_to_unique_name);

CREATE TABLE commits (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  repository_id uuid NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  commit_id text NOT NULL,
  author_name text NOT NULL,
  author_email text,
  message text NOT NULL,
  committed_at timestamptz NOT NULL,
  web_url text NOT NULL,
  PRIMARY KEY (repository_id, commit_id)
);
CREATE INDEX commits_recent ON commits (tenant_id, committed_at DESC);

CREATE TABLE pull_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  repository_id uuid NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  azure_pr_id integer NOT NULL,
  title text NOT NULL,
  status text NOT NULL,
  source_branch text NOT NULL,
  target_branch text NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL,
  closed_at timestamptz,
  web_url text NOT NULL,
  work_item_azure_ids integer[] NOT NULL DEFAULT '{}',
  UNIQUE (repository_id, azure_pr_id)
);

CREATE TABLE agent_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  work_item_id uuid NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  branch text,
  pull_request_urls text[] NOT NULL DEFAULT '{}',
  error text,
  log text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz
);
-- At most one active run per work item.
CREATE UNIQUE INDEX agent_runs_one_active ON agent_runs (work_item_id) WHERE status IN ('queued', 'running');
CREATE INDEX agent_runs_queue ON agent_runs (status, created_at);

CREATE TABLE activity (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  actor text NOT NULL,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX activity_recent ON activity (tenant_id, created_at DESC);

-- Row-level security ---------------------------------------------------------------

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'secrets', 'azure_connections', 'teams', 'team_members', 'agents', 'skills',
    'mcp_servers', 'agent_skills', 'agent_mcp_servers', 'repositories', 'work_items',
    'commits', 'pull_requests', 'agent_runs', 'activity'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid) '
      || 'WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)', t);
  END LOOP;
END $$;
