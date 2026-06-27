import type {
  AgentJob,
  AppStatus,
  AppSummary,
  Deployment,
  JobEvent,
  Manifest,
  PlatformAppDetail,
  PlatformOverview,
  ReadModelInfo,
  ReadModelResult,
} from "@vibe/shared";
import { loadCredentials } from "./config.js";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

async function call<T>(
  method: string,
  path: string,
  opts: { body?: unknown; raw?: Buffer; contentType?: string } = {}
): Promise<T> {
  const creds = await loadCredentials();
  const headers: Record<string, string> = {
    authorization: `Bearer ${creds.token}`,
  };
  let body: Buffer | string | undefined;
  if (opts.raw) {
    headers["content-type"] = opts.contentType ?? "application/octet-stream";
    body = opts.raw;
  } else if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.body);
  }

  const res = await fetch(`${creds.apiUrl}${path}`, { method, headers, body });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const msg = (json as { error?: unknown }).error;
    throw new ApiError(
      typeof msg === "string" ? msg : `${method} ${path} failed`,
      res.status
    );
  }
  return json as T;
}

export const api = {
  registerApp: (manifest: Manifest) =>
    call<{ app: AppSummary }>("POST", "/api/apps", { body: { manifest } }),

  listApps: () => call<{ apps: AppSummary[] }>("GET", "/api/apps"),

  getStatus: (id: string, env = "prod") =>
    call<{ status: AppStatus }>("GET", `/api/apps/${id}/status?env=${encodeURIComponent(env)}`),

  deploy: (id: string, tarGz: Buffer, env = "prod") =>
    call<{ deploymentId: string; appId: string }>(
      "POST",
      `/api/apps/${id}/deploy?env=${encodeURIComponent(env)}`,
      { raw: tarGz, contentType: "application/gzip" }
    ),

  getDeployment: (id: string) =>
    call<{ deployment: Deployment; buildLog: string }>(
      "GET",
      `/api/deployments/${id}`
    ),

  logs: (id: string, build: boolean, tail = 200, env = "prod") =>
    call<{ log: string }>(
      "GET",
      `/api/apps/${id}/logs?env=${encodeURIComponent(env)}&${build ? "build=1" : `tail=${tail}`}`
    ),

  invite: (id: string, email: string, role: string) =>
    call<{ email: string; role: string; claimUrl: string }>(
      "POST",
      `/api/apps/${id}/invite`,
      { body: { email, role } }
    ),

  rollback: (id: string, env = "prod") =>
    call<{ rolledBackTo: string }>("POST", `/api/apps/${id}/rollback`, { body: { env } }),

  promote: (id: string, from = "test", to = "prod") =>
    call<{ deploymentId: string; appId: string }>("POST", `/api/apps/${id}/promote`, {
      body: { from, to },
    }),

  deployImage: (
    id: string,
    body: { image: string; sha?: string; ref?: string; env?: string }
  ) =>
    call<{ deploymentId: string; appId: string }>(
      "POST",
      `/api/apps/${id}/deploy/image`,
      { body }
    ),

  createRepo: (id: string, body: { name?: string; private?: boolean } = {}) =>
    call<{
      repo: string;
      cloneUrl: string;
      sshUrl?: string;
      htmlUrl: string;
      defaultBranch: string;
    }>("POST", `/api/apps/${id}/github/repo`, { body }),

  getGithub: (id: string) =>
    call<{ repo: string; defaultBranch: string; htmlUrl: string | null }>(
      "GET",
      `/api/apps/${id}/github`
    ),

  // Hard delete: tears down container(s), database, storage, and routing on
  // the VPS, then removes all records. The `confirm` query param (= the app
  // id) is what the control plane requires to distinguish this from archive.
  // Pass `deleteRepo: true` to also delete the linked GitHub repo and GHCR package.
  deleteApp: (id: string, opts: { deleteRepo?: boolean } = {}) => {
    const params = new URLSearchParams({ confirm: id });
    if (opts.deleteRepo) params.set("deleteRepo", "true");
    return call<{ deleted: boolean }>("DELETE", `/api/apps/${id}?${params}`);
  },

  /* ---- platform query layer (what LLMs use to reason about the platform) ---- */

  platformOverview: () =>
    call<PlatformOverview>("GET", "/api/platform/overview"),

  platformApp: (id: string) =>
    call<PlatformAppDetail>("GET", `/api/platform/apps/${id}`),

  listReadModels: (id: string) =>
    call<{ models: ReadModelInfo[] }>("GET", `/api/platform/apps/${id}/models`),

  runReadModel: (id: string, model: string, params: Record<string, unknown>) =>
    call<ReadModelResult>("POST", `/api/platform/apps/${id}/query`, {
      body: { model, params },
    }),

  /* ---- agent / daemon relay (the on-machine `vibe agent` consumes these) ---- */

  registerAgent: (name: string) =>
    call<{ machineId: string; name: string }>("POST", "/api/agent/register", {
      body: { name },
    }),

  agentHeartbeat: (machineId: string) =>
    call<{ ok: boolean }>("POST", "/api/agent/heartbeat", { body: { machineId } }),

  // Long-poll: resolves with { job } when one is claimed, or {} on timeout.
  claimJob: (machineId: string) =>
    call<{ job?: AgentJob }>("GET", `/api/agent/jobs/claim?machine=${encodeURIComponent(machineId)}`),

  // Atomically claim pending local-folder cleanup requests for deleted apps.
  pollCleanups: () => call<{ appIds: string[] }>("GET", "/api/agent/cleanups"),

  postJobEvents: (jobId: string, events: JobEvent[]) =>
    call<{ ok: boolean }>("POST", `/api/agent/jobs/${jobId}/events`, { body: { events } }),

  completeJob: (
    jobId: string,
    body: {
      status: "done" | "failed" | "stopped";
      error?: string;
      llmSessionId?: string;
      llmProvider?: string;
      finalText?: string;
    }
  ) => call<{ ok: boolean }>("POST", `/api/agent/jobs/${jobId}/complete`, { body }),

  checkJobCancelled: (jobId: string) =>
    call<{ status: string; cancelling: boolean }>("GET", `/api/agent/jobs/${jobId}/status`),

  completeVerifyJob: (
    jobId: string,
    body: {
      passed: boolean;
      testOutput: string;
      screenshotPaths: Record<string, string>;
    }
  ) =>
    call<{ ok: boolean; adjustJobId: string | null }>(
      "POST",
      `/api/agent/jobs/${jobId}/verify-complete`,
      { body }
    ),
};
