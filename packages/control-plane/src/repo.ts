import type { AppEnvironment, AppSummary, Deployment, Health, Manifest } from "@vibe/shared";
import { loadConfig } from "./config.js";
import { one, query } from "./db.js";

export interface AppRow {
  id: string;
  name: string;
  description: string;
  visibility: string;
  access_mode: string;
  default_role: string;
  subdomain: string;
  manifest: Manifest;
  status: string;
  current_deployment_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface DeploymentRow {
  id: string;
  app_id: string;
  environment: AppEnvironment;
  status: string;
  image_tag: string | null;
  container_name: string | null;
  port: number | null;
  health: string;
  error: string | null;
  build_log: string;
  rollback_target: string | null;
  source: string;
  git_sha: string | null;
  git_ref: string | null;
  created_at: Date;
  completed_at: Date | null;
}

export interface AppEnvironmentRow {
  app_id: string;
  environment: AppEnvironment;
  status: string;
  current_deployment_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface AppRepoRow {
  app_id: string;
  provider: string;
  repo_full_name: string;
  default_branch: string;
  html_url: string | null;
  created_at: Date;
}

export async function getApp(id: string): Promise<AppRow | null> {
  return one<AppRow>("SELECT * FROM apps WHERE id = $1", [id]);
}

export async function getAppRepo(appId: string): Promise<AppRepoRow | null> {
  return one<AppRepoRow>("SELECT * FROM app_repos WHERE app_id = $1", [appId]);
}

export async function upsertAppRepo(repo: {
  appId: string;
  repoFullName: string;
  defaultBranch: string;
  htmlUrl: string | null;
}): Promise<void> {
  await query(
    `INSERT INTO app_repos (app_id, provider, repo_full_name, default_branch, html_url)
     VALUES ($1, 'github', $2, $3, $4)
     ON CONFLICT (app_id) DO UPDATE SET
       repo_full_name = EXCLUDED.repo_full_name,
       default_branch = EXCLUDED.default_branch,
       html_url       = EXCLUDED.html_url`,
    [repo.appId, repo.repoFullName, repo.defaultBranch, repo.htmlUrl]
  );
}

export async function listApps(): Promise<AppRow[]> {
  const res = await query<AppRow>(
    "SELECT * FROM apps WHERE status <> 'archived' ORDER BY updated_at DESC"
  );
  return res.rows;
}

export async function getDeployment(id: string): Promise<DeploymentRow | null> {
  return one<DeploymentRow>("SELECT * FROM deployments WHERE id = $1", [id]);
}

export async function recentDeployments(
  appId: string,
  environment: AppEnvironment = "prod",
  limit = 5
): Promise<DeploymentRow[]> {
  const res = await query<DeploymentRow>(
    "SELECT * FROM deployments WHERE app_id = $1 AND environment = $2 ORDER BY created_at DESC LIMIT $3",
    [appId, environment, limit]
  );
  return res.rows;
}

export async function ensureAppEnvironment(
  appId: string,
  environment: AppEnvironment
): Promise<AppEnvironmentRow> {
  await query(
    `INSERT INTO app_environments (app_id, environment)
     VALUES ($1, $2)
     ON CONFLICT (app_id, environment) DO NOTHING`,
    [appId, environment]
  );
  return (await one<AppEnvironmentRow>(
    "SELECT * FROM app_environments WHERE app_id = $1 AND environment = $2",
    [appId, environment]
  ))!;
}

export async function getAppEnvironment(
  appId: string,
  environment: AppEnvironment = "prod"
): Promise<AppEnvironmentRow | null> {
  return one<AppEnvironmentRow>(
    "SELECT * FROM app_environments WHERE app_id = $1 AND environment = $2",
    [appId, environment]
  );
}

export function envSubdomain(subdomain: string, environment: AppEnvironment): string {
  return environment === "prod" ? subdomain : `${subdomain}-${environment}`;
}

export function deploymentToContract(row: DeploymentRow): Deployment {
  return {
    id: row.id,
    appId: row.app_id,
    environment: row.environment ?? "prod",
    status: row.status as Deployment["status"],
    imageTag: row.image_tag,
    health: row.health as Health,
    error: row.error,
    source: (row.source as Deployment["source"]) ?? "context",
    gitSha: row.git_sha,
    gitRef: row.git_ref,
    createdAt: row.created_at.toISOString(),
    completedAt: row.completed_at ? row.completed_at.toISOString() : null,
  };
}

export async function appSummary(
  row: AppRow,
  environment: AppEnvironment = "prod"
): Promise<AppSummary> {
  const cfg = loadConfig();
  const env = await getAppEnvironment(row.id, environment);
  const currentId = env?.current_deployment_id ?? (environment === "prod" ? row.current_deployment_id : null);
  const current = currentId
    ? await getDeployment(currentId)
    : null;
  const status = env?.status ?? (environment === "prod" ? row.status : "registered");
  return {
    id: row.id,
    name: row.name,
    environment,
    visibility: row.visibility,
    status,
    url:
      status === "live"
        ? `https://${envSubdomain(row.subdomain, environment)}.${cfg.appsDomain}`
        : null,
    health: (current?.health as Health) ?? "unknown",
    currentDeploymentId: currentId,
    lastDeployedAt: current?.completed_at
      ? current.completed_at.toISOString()
      : null,
    icon: row.manifest.icon?.trim() ?? null,
  };
}
