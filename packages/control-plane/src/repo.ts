import type { AppSummary, Deployment, Health, Manifest } from "@vibe/shared";
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
  status: string;
  image_tag: string | null;
  container_name: string | null;
  port: number | null;
  health: string;
  error: string | null;
  build_log: string;
  rollback_target: string | null;
  created_at: Date;
  completed_at: Date | null;
}

export async function getApp(id: string): Promise<AppRow | null> {
  return one<AppRow>("SELECT * FROM apps WHERE id = $1", [id]);
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
  limit = 5
): Promise<DeploymentRow[]> {
  const res = await query<DeploymentRow>(
    "SELECT * FROM deployments WHERE app_id = $1 ORDER BY created_at DESC LIMIT $2",
    [appId, limit]
  );
  return res.rows;
}

export function deploymentToContract(row: DeploymentRow): Deployment {
  return {
    id: row.id,
    appId: row.app_id,
    status: row.status as Deployment["status"],
    imageTag: row.image_tag,
    health: row.health as Health,
    error: row.error,
    createdAt: row.created_at.toISOString(),
    completedAt: row.completed_at ? row.completed_at.toISOString() : null,
  };
}

export async function appSummary(row: AppRow): Promise<AppSummary> {
  const cfg = loadConfig();
  const current = row.current_deployment_id
    ? await getDeployment(row.current_deployment_id)
    : null;
  return {
    id: row.id,
    name: row.name,
    visibility: row.visibility,
    status: row.status,
    url:
      row.status === "live"
        ? `https://${row.subdomain}.${cfg.appsDomain}`
        : null,
    health: (current?.health as Health) ?? "unknown",
    currentDeploymentId: row.current_deployment_id,
    lastDeployedAt: current?.completed_at
      ? current.completed_at.toISOString()
      : null,
  };
}
