import type { Fetch } from "../src/azure/client.js";

/** In-memory Azure DevOps REST fake covering the endpoints the platform calls. */
export function createFakeAzure(options: { org: string; project: string; pat: string; repoRemote: (name: string) => string }) {
  const workItems = new Map<number, { id: number; rev: number; fields: Record<string, unknown> }>();
  const teams = [{ id: "team-1", name: "Backend", members: [
    { displayName: "Jane Doe", uniqueName: "Jane@Acme.com" },
    { displayName: "Joe Smith", uniqueName: "joe@acme.com" },
  ] }];
  const repos = [{ id: "repo-1", name: "api", defaultBranch: "refs/heads/main" }];
  const pullRequests: Array<{ pullRequestId: number; repo: string; title: string; status: string; sourceRefName: string;
    targetRefName: string; workItemIds: number[]; creationDate: string }> = [];
  const comments: Array<{ id: number; text: string }> = [];
  const commits = [{ commitId: "c0ffee", author: { name: "Jane Doe", email: "jane@acme.com", date: new Date().toISOString() },
    comment: "AB#1 initial scaffolding", remoteUrl: "" }];

  function addWorkItem(id: number, fields: Record<string, unknown>) {
    workItems.set(id, { id, rev: 1, fields: { "System.ChangedDate": new Date().toISOString(), ...fields } });
  }

  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const repoWeb = (name: string) => `${options.org}/${options.project}/_git/${name}`;

  const fetch: Fetch = async (url, init) => {
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    if (headers.get("Authorization") !== `Basic ${Buffer.from(`:${options.pat}`).toString("base64")}`) return json({}, 401);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const path = decodeURIComponent(new URL(url).pathname);
    const projectPrefix = new URL(options.org).pathname + `/${options.project}`;

    if (method === "GET" && path.endsWith(`/_apis/projects/${options.project}`)) return json({ id: "p1", name: options.project });
    if (method === "GET" && /\/_apis\/projects\/[^/]+\/teams$/.test(path)) return json({ value: teams.map(({ id, name }) => ({ id, name })) });
    const membersMatch = path.match(/\/teams\/([^/]+)\/members$/);
    if (method === "GET" && membersMatch) return json({ value: teams.find((t) => t.id === membersMatch[1])!.members.map((identity) => ({ identity })) });
    if (method === "POST" && path === `${projectPrefix}/_apis/wit/wiql`) return json({ workItems: [...workItems.keys()].map((id) => ({ id })) });
    if (method === "POST" && path === `${projectPrefix}/_apis/wit/workitemsbatch`) {
      return json({ value: (body.ids as number[]).map((id) => workItems.get(id)).filter(Boolean) });
    }
    const wiMatch = path.match(/\/_apis\/wit\/workitems\/(\d+)$/);
    if (method === "PATCH" && wiMatch) {
      const item = workItems.get(Number(wiMatch[1]))!;
      for (const op of body as Array<{ path: string; value: unknown }>) {
        const field = op.path.replace("/fields/", "");
        item.fields[field] = field === "System.AssignedTo" && op.value
          ? teams.flatMap((t) => t.members).find((m) => m.uniqueName.toLowerCase() === String(op.value).toLowerCase())
          : op.value;
      }
      item.rev += 1;
      item.fields["System.ChangedDate"] = new Date().toISOString();
      return json(item);
    }
    const commentMatch = path.match(/\/_apis\/wit\/workItems\/(\d+)\/comments$/);
    if (method === "POST" && commentMatch) { comments.push({ id: Number(commentMatch[1]), text: body.text }); return json({ id: comments.length }); }
    if (method === "GET" && path === `${projectPrefix}/_apis/git/repositories`) {
      return json({ value: repos.map((repo) => ({ ...repo, remoteUrl: options.repoRemote(repo.name), webUrl: repoWeb(repo.name) })) });
    }
    const repoMatch = path.match(/\/_apis\/git\/repositories\/([^/]+)\/(\w+)(?:\/(\d+)\/(\w+))?$/);
    if (repoMatch) {
      const [, repo, resource, prId, sub] = repoMatch;
      if (resource === "commits") return json({ value: commits });
      if (resource === "items") return json({ value: [{ path: "/package.json" }, { path: "/tsconfig.json" }, { path: "/src", isFolder: true }] });
      if (resource === "pullrequests" && method === "GET") {
        return json({ value: pullRequests.filter((pr) => pr.repo === repo).map((pr) => ({
          ...pr, createdBy: { displayName: "agent", uniqueName: "agent" }, repository: { id: "repo-1", name: repo } })) });
      }
      if (resource === "pullrequests" && method === "POST") {
        const pr = { pullRequestId: pullRequests.length + 1, repo: repo!, title: body.title, status: "active",
          sourceRefName: body.sourceRefName, targetRefName: body.targetRefName, creationDate: new Date().toISOString(),
          workItemIds: (body.workItemRefs as Array<{ id: string }>).map((ref) => Number(ref.id)) };
        pullRequests.push(pr);
        return json({ ...pr, createdBy: { displayName: "agent", uniqueName: "agent" }, repository: { id: "repo-1", name: repo, webUrl: repoWeb(repo!) } }, 201);
      }
      if (resource === "pullRequests" && sub === "workitems") {
        return json({ value: (pullRequests.find((pr) => pr.pullRequestId === Number(prId))?.workItemIds ?? []).map((id) => ({ id: String(id) })) });
      }
    }
    return json({ message: `no fake route: ${method} ${path}` }, 404);
  };

  return { fetch, workItems, pullRequests, comments, addWorkItem };
}
