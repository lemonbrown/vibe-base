import type { FastifyInstance } from "fastify";
import type { AppEnvironment, AppStatus } from "@vibe/shared";
import { query } from "../db.js";
import { isDatabaseProvisioned } from "../services/dbProvision.js";
import { isStorageProvisioned } from "../services/storage.js";
import {
  appSummary,
  deploymentToContract,
  getApp,
  getAppRepo,
  recentDeployments,
} from "../repo.js";
import { requireOwner } from "./guards.js";

function normalizeEnv(value: unknown): AppEnvironment {
  return value === "test" ? "test" : "prod";
}

export async function statusRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string }; Querystring: { env?: string } }>("/api/apps/:id/status", async (req, reply) => {
    const actor = await requireOwner(req, reply);
    if (!actor) return;
    const row = await getApp(req.params.id);
    if (!row) return reply.code(404).send({ error: "app not found" });

    const m = row.manifest;
    const environment = normalizeEnv(req.query.env);
    const [memberCount, deps, appRepo] = await Promise.all([
      query<{ n: string }>(
        "SELECT count(*)::text AS n FROM app_members WHERE app_id = $1 AND status = 'active'",
        [row.id]
      ),
      recentDeployments(row.id, environment, 5),
      getAppRepo(row.id),
    ]);

    const status: AppStatus = {
      app: await appSummary(row, environment),
      manifestSummary: {
        runtimeAdapter: m.runtime.adapter,
        port: m.runtime.port,
        healthPath: m.runtime.healthPath,
        capabilities: m.capabilities as unknown as Record<string, boolean>,
      },
      database: {
        enabled: m.capabilities.database,
        provisioned: await isDatabaseProvisioned(row.id, environment),
      },
      storage: {
        enabled: m.capabilities.storage,
        provisioned: await isStorageProvisioned(row.id, environment),
      },
      members: Number(memberCount.rows[0]?.n ?? "0"),
      recentDeployments: deps.map(deploymentToContract),
      repo: appRepo
        ? {
            repoFullName: appRepo.repo_full_name,
            defaultBranch: appRepo.default_branch,
            htmlUrl: appRepo.html_url,
          }
        : null,
    };
    return reply.send({ status });
  });
}
