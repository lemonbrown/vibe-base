import type {
  AppSummary,
  AppStatus,
  Deployment,
  Member,
  Conversation,
  ConversationDetail,
  PlatformRole,
  JobKind,
  MachineStatus,
  OwnerSettings,
} from "@vibe/shared";

export type { MachineStatus, OwnerSettings };

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Redirect the whole browser to the server-rendered login, preserving where
 *  we were so the session round-trip lands the user back here. */
function toLogin(): never {
  const next = window.location.href;
  window.location.href = `/login?next=${encodeURIComponent(next)}`;
  // Stop the calling code; navigation is already underway.
  throw new ApiError(401, "redirecting to login");
}

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: "same-origin",
    headers:
      init?.body != null ? { "content-type": "application/json" } : undefined,
    ...init,
  });
  if (res.status === 401) toLogin();
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    let msg = body;
    try {
      const j = JSON.parse(body);
      msg = typeof j.error === "string" ? j.error : JSON.stringify(j.error ?? j);
    } catch {
      /* plain text */
    }
    throw new ApiError(res.status, msg || `${res.status} ${res.statusText}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

const body = (v: unknown) => JSON.stringify(v);

/* --------------------------------- apps --------------------------------- */

export const api = {
  listApps: () => http<{ apps: AppSummary[] }>("/api/apps").then((r) => r.apps),

  getAppStatus: (id: string) =>
    http<{ status: AppStatus }>(`/api/apps/${id}/status`).then((r) => r.status),

  getMembers: (id: string) =>
    http<{ members: Member[] }>(`/api/apps/${id}/members`).then((r) => r.members),

  getDeployments: (id: string) =>
    http<{ deployments: Deployment[] }>(`/api/apps/${id}/deployments`).then(
      (r) => r.deployments
    ),

  getLogs: (id: string, opts: { build?: boolean; tail?: number } = {}) => {
    const q = new URLSearchParams();
    if (opts.build) q.set("build", "1");
    if (opts.tail) q.set("tail", String(opts.tail));
    const qs = q.toString();
    return http<{ log: string }>(
      `/api/apps/${id}/logs${qs ? `?${qs}` : ""}`
    ).then((r) => r.log);
  },

  invite: (id: string, email: string, role: PlatformRole) =>
    http<{ email: string; role: string; claimUrl: string }>(
      `/api/apps/${id}/invite`,
      { method: "POST", body: body({ email, role }) }
    ),

  revoke: (id: string, email: string) =>
    http<{ revoked: string }>(`/api/apps/${id}/revoke`, {
      method: "POST",
      body: body({ email }),
    }),

  rollback: (id: string) =>
    http<{ rolledBackTo: string }>(`/api/apps/${id}/rollback`, {
      method: "POST",
    }),

  deleteApp: (id: string) =>
    http<{ deleted: boolean }>(
      `/api/apps/${id}?confirm=${encodeURIComponent(id)}`,
      { method: "DELETE" }
    ),

  /* --------------------------------- chat -------------------------------- */

  listConversations: () =>
    http<{ conversations: Conversation[] }>("/api/chat").then(
      (r) => r.conversations
    ),

  getConversation: (id: string) =>
    http<{ conversation: ConversationDetail }>(`/api/chat/${id}`).then(
      (r) => r.conversation
    ),

  newConversation: () =>
    http<{ conversation: Conversation }>("/api/chat", {
      method: "POST",
      body: body({}),
    }).then((r) => r.conversation),

  sendMessage: (
    convId: string,
    payload: {
      content: string;
      kind: JobKind;
      targetApp: string | null;
      planMode: boolean;
    }
  ) =>
    http<{
      jobId: string;
      userMessageId: string;
      assistantMessageId: string;
    }>(`/api/chat/${convId}/messages`, {
      method: "POST",
      body: body(payload),
    }),

  stopConversation: (convId: string) =>
    http<{ ok: boolean; jobId: string | null }>(`/api/chat/${convId}/stop`, {
      method: "POST",
    }),

  /* -------------------------------- agent -------------------------------- */

  getMachineStatus: () =>
    http<{ machine: MachineStatus | null }>("/api/agent/status").then(
      (r) => r.machine
    ),

  /* ------------------------------- settings ------------------------------ */

  getSettings: () =>
    http<{ settings: OwnerSettings }>("/api/settings").then((r) => r.settings),

  updateSettings: (patch: Partial<OwnerSettings>) =>
    http<{ settings: OwnerSettings }>("/api/settings", {
      method: "PUT",
      body: body(patch),
    }).then((r) => r.settings),
};
