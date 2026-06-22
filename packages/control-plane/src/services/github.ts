import _sodium from "libsodium-wrappers";
import { loadConfig } from "../config.js";

/**
 * Thin wrapper over the GitHub REST API, authenticated with the platform's
 * stored token (a PAT in the MVP). Every call throws on a non-2xx response so
 * routes can decide whether a failure is fatal or best-effort.
 */

let sodiumReady: Promise<typeof _sodium> | null = null;
async function sodium(): Promise<typeof _sodium> {
  if (!sodiumReady) sodiumReady = _sodium.ready.then(() => _sodium);
  return sodiumReady;
}

export function githubEnabled(): boolean {
  return Boolean(loadConfig().github.token);
}

async function gh<T>(
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const { github } = loadConfig();
  if (!github.token) {
    throw new Error("GitHub integration not configured (set GITHUB_TOKEN)");
  }
  const headers: Record<string, string> = {
    authorization: `Bearer ${github.token}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "vibe-base",
  };
  if (body !== undefined) headers["content-type"] = "application/json";

  const res = await fetch(`${github.apiBase}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const msg = (json as { message?: string }).message ?? text;
    throw new Error(`GitHub ${method} ${path} failed (${res.status}): ${msg}`);
  }
  return json as T;
}

export interface CreatedRepo {
  fullName: string;
  cloneUrl: string;
  sshUrl: string;
  htmlUrl: string;
  defaultBranch: string;
}

interface RepoResponse {
  full_name: string;
  clone_url: string;
  ssh_url: string;
  html_url: string;
  default_branch: string;
}

export async function createRepo(opts: {
  name: string;
  description?: string;
  private?: boolean;
}): Promise<CreatedRepo> {
  const { github } = loadConfig();
  const path =
    github.ownerIsOrg && github.owner
      ? `/orgs/${github.owner}/repos`
      : `/user/repos`;
  const r = await gh<RepoResponse>("POST", path, {
    name: opts.name,
    description: opts.description ?? "",
    private: opts.private ?? true,
    auto_init: false,
  });
  return {
    fullName: r.full_name,
    cloneUrl: r.clone_url,
    sshUrl: r.ssh_url,
    htmlUrl: r.html_url,
    defaultBranch: r.default_branch || "main",
  };
}

/** Encrypt a value with a repo's Actions public key (libsodium sealed box). */
async function sealValue(publicKey: string, value: string): Promise<string> {
  const s = await sodium();
  const binkey = s.from_base64(publicKey, s.base64_variants.ORIGINAL);
  const binsec = s.from_string(value);
  const sealed = s.crypto_box_seal(binsec, binkey);
  return s.to_base64(sealed, s.base64_variants.ORIGINAL);
}

/** Create or update an encrypted Actions secret on the repo. */
export async function setActionsSecret(
  fullName: string,
  name: string,
  value: string
): Promise<void> {
  const pk = await gh<{ key: string; key_id: string }>(
    "GET",
    `/repos/${fullName}/actions/secrets/public-key`
  );
  const encrypted_value = await sealValue(pk.key, value);
  await gh("PUT", `/repos/${fullName}/actions/secrets/${name}`, {
    encrypted_value,
    key_id: pk.key_id,
  });
}

/** Create or update a (non-secret) Actions variable on the repo. */
export async function setActionsVariable(
  fullName: string,
  name: string,
  value: string
): Promise<void> {
  try {
    await gh("POST", `/repos/${fullName}/actions/variables`, { name, value });
  } catch (err) {
    // Already exists → update in place.
    if (err instanceof Error && /\(409\)/.test(err.message)) {
      await gh("PATCH", `/repos/${fullName}/actions/variables/${name}`, {
        name,
        value,
      });
      return;
    }
    throw err;
  }
}

/** Create a GitHub Deployment; returns its numeric id. */
export async function createDeployment(
  fullName: string,
  ref: string,
  environment = "production"
): Promise<number> {
  const dep = await gh<{ id: number }>(
    "POST",
    `/repos/${fullName}/deployments`,
    {
      ref,
      environment,
      auto_merge: false,
      required_contexts: [],
      description: "Vibe Base deploy",
    }
  );
  return dep.id;
}

export type DeploymentState =
  | "queued"
  | "in_progress"
  | "success"
  | "failure"
  | "error";

export async function setDeploymentStatus(
  fullName: string,
  deploymentId: number,
  state: DeploymentState,
  opts: { environmentUrl?: string; description?: string } = {}
): Promise<void> {
  await gh("POST", `/repos/${fullName}/deployments/${deploymentId}/statuses`, {
    state,
    environment_url: opts.environmentUrl,
    description: opts.description,
  });
}
