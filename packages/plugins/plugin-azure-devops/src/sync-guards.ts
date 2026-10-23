/**
 * Pure helpers for sync reliability and guardrails. Kept free of plugin
 * context so they can be unit tested directly.
 */
import { timingSafeEqual } from "node:crypto";
import { DEFAULT_WORK_ITEM_QUERY, type PaperclipStatus } from "./mapping.js";

export const RETRYABLE_STATUSES = new Set([429, 503]);
export const MAX_ATTEMPTS = 3;

/** Delay before retry `attempt` (1-based) honoring Retry-After seconds or HTTP date. */
export function retryDelayMs(retryAfter: string | null, attempt: number, now = Date.now()): number {
  const maxDelay = 30_000;
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, maxDelay);
    const date = Date.parse(retryAfter);
    if (!Number.isNaN(date)) return Math.min(Math.max(date - now, 0), maxDelay);
  }
  return Math.min(500 * 2 ** (attempt - 1), maxDelay);
}

/** Calls `send` up to MAX_ATTEMPTS times while it returns 429/503. */
export async function fetchWithRetry(
  send: () => Promise<Response>,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<Response> {
  for (let attempt = 1; ; attempt += 1) {
    const response = await send();
    if (!RETRYABLE_STATUSES.has(response.status) || attempt >= MAX_ATTEMPTS) return response;
    await sleep(retryDelayMs(response.headers.get("retry-after"), attempt));
  }
}

/**
 * The default query is narrowed to items changed since the last successful sync.
 * WIQL date precision is one day, so the filter uses the UTC date of the last sync.
 * Custom queries are returned unchanged.
 */
export function buildSyncQuery(query: string, lastSuccessfulSyncAt: string | null | undefined): string {
  if (query !== DEFAULT_WORK_ITEM_QUERY || !lastSuccessfulSyncAt) return query;
  const last = new Date(lastSuccessfulSyncAt);
  if (Number.isNaN(last.getTime())) return query;
  const day = last.toISOString().slice(0, 10);
  return query.replace("ORDER BY", `AND [System.ChangedDate] >= '${day}' ORDER BY`);
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  // Compare against itself on length mismatch to keep timing uniform.
  if (left.length !== right.length) {
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

function header(headers: Record<string, string | string[]>, name: string): string | null {
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name);
  if (!key) return null;
  const value = headers[key];
  return (Array.isArray(value) ? value[0] : value) ?? null;
}

/** Accepts the secret as the HTTP Basic password or an `X-Paperclip-Webhook-Secret` header. */
export function verifyWebhookSecret(headers: Record<string, string | string[]>, secret: string): boolean {
  if (!secret) return false;
  let matched = false;
  const direct = header(headers, "x-paperclip-webhook-secret");
  if (direct !== null && safeEqual(direct, secret)) matched = true;
  const authorization = header(headers, "authorization");
  if (authorization?.toLowerCase().startsWith("basic ")) {
    const decoded = Buffer.from(authorization.slice(6).trim(), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    const password = separator >= 0 ? decoded.slice(separator + 1) : decoded;
    if (safeEqual(password, secret)) matched = true;
  }
  return matched;
}

export interface ServiceHookWorkItem {
  workItemId: number;
  project: string | null;
}

/** Extracts the work item id from a `workitem.created` / `workitem.updated` service hook payload. */
export function parseServiceHook(body: unknown): ServiceHookWorkItem | null {
  if (!body || typeof body !== "object") return null;
  const payload = body as { eventType?: unknown; resource?: Record<string, unknown> };
  if (payload.eventType !== "workitem.created" && payload.eventType !== "workitem.updated") return null;
  const resource = payload.resource ?? {};
  // `updated` hooks carry the item id as `workItemId`; `created` hooks as `id`.
  const id = Number(payload.eventType === "workitem.updated" ? resource.workItemId ?? resource.id : resource.id);
  if (!Number.isInteger(id) || id <= 0) return null;
  const revision = (payload.eventType === "workitem.updated" ? resource.revision : resource) as
    | { fields?: Record<string, unknown> }
    | undefined;
  const project = revision?.fields?.["System.TeamProject"];
  return { workItemId: id, project: typeof project === "string" ? project : null };
}

/** Status and assignee for a newly created task. */
export function initialTaskPlacement(input: {
  azureStatus: PaperclipStatus;
  assigneeAgentId: string | undefined;
  requireTriage: boolean;
}): { status: PaperclipStatus; assigneeAgentId: string | undefined } {
  if (input.azureStatus === "done" || input.azureStatus === "cancelled") {
    return { status: input.azureStatus, assigneeAgentId: input.assigneeAgentId };
  }
  if (input.requireTriage && !input.assigneeAgentId) return { status: "backlog", assigneeAgentId: undefined };
  return { status: "todo", assigneeAgentId: input.assigneeAgentId };
}
