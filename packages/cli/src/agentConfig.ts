import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

/**
 * Daemon configuration, kept next to credentials in ~/.vibe/agent.json.
 *
 * - `workspaceRoot` is the settable base path where the daemon creates new app
 *   directories (workspaceRoot/<app-id>).
 * - `apps` is a registry mapping an app id to an explicit local path, for apps
 *   that already live somewhere other than under workspaceRoot.
 */
export interface AgentConfig {
  workspaceRoot: string;
  apps: Record<string, string>;
  machineId?: string;
  machineName?: string;
}

function agentPath(): string {
  return join(homedir(), ".vibe", "agent.json");
}

export function defaultWorkspaceRoot(): string {
  return join(homedir(), "vibe-apps");
}

export async function loadAgentConfig(): Promise<AgentConfig> {
  try {
    const raw = await readFile(agentPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<AgentConfig>;
    return {
      workspaceRoot: parsed.workspaceRoot ?? defaultWorkspaceRoot(),
      apps: parsed.apps ?? {},
      machineId: parsed.machineId,
      machineName: parsed.machineName,
    };
  } catch {
    return { workspaceRoot: defaultWorkspaceRoot(), apps: {} };
  }
}

export async function saveAgentConfig(cfg: AgentConfig): Promise<void> {
  const p = agentPath();
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(cfg, null, 2), "utf8");
}

export function agentConfigPath(): string {
  return agentPath();
}

/**
 * Resolve where on disk an app's code lives: an explicit registry entry wins,
 * otherwise the convention workspaceRoot/<app-id>. Always returns an absolute
 * path (the second slot tells the caller whether it was a registered override).
 */
export function resolveAppPath(
  cfg: AgentConfig,
  appId: string
): { path: string; registered: boolean } {
  const registered = cfg.apps[appId];
  if (registered) {
    return { path: isAbsolute(registered) ? registered : resolve(registered), registered: true };
  }
  return { path: join(cfg.workspaceRoot, appId), registered: false };
}
