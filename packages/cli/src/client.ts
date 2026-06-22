import type {
  AppStatus,
  AppSummary,
  Deployment,
  Manifest,
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

  getStatus: (id: string) =>
    call<{ status: AppStatus }>("GET", `/api/apps/${id}/status`),

  deploy: (id: string, tarGz: Buffer) =>
    call<{ deploymentId: string; appId: string }>(
      "POST",
      `/api/apps/${id}/deploy`,
      { raw: tarGz, contentType: "application/gzip" }
    ),

  getDeployment: (id: string) =>
    call<{ deployment: Deployment; buildLog: string }>(
      "GET",
      `/api/deployments/${id}`
    ),

  logs: (id: string, build: boolean, tail = 200) =>
    call<{ log: string }>(
      "GET",
      `/api/apps/${id}/logs?${build ? "build=1" : `tail=${tail}`}`
    ),

  invite: (id: string, email: string, role: string) =>
    call<{ email: string; role: string; claimUrl: string }>(
      "POST",
      `/api/apps/${id}/invite`,
      { body: { email, role } }
    ),

  rollback: (id: string) =>
    call<{ rolledBackTo: string }>("POST", `/api/apps/${id}/rollback`),

  deployImage: (
    id: string,
    body: { image: string; sha?: string; ref?: string }
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
};
