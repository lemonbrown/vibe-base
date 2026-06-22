import type { FastifyInstance } from "fastify";
import type { AppStatus } from "@vibe/shared";
import { query } from "../db.js";
import { isDatabaseProvisioned } from "../services/dbProvision.js";
import { isStorageProvisioned } from "../services/storage.js";
import {
  appSummary,
  deploymentToContract,
  getApp,
  recentDeployments,
} from "../repo.js";
import { requireOwner } from "./guards.js";

export async function statusRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string } }>("/api/apps/:id/status", async (req, reply) => {
    const actor = await requireOwner(req, reply);
    if (!actor) return;
    const row = await getApp(req.params.id);
    if (!row) return reply.code(404).send({ error: "app not found" });

    const m = row.manifest;
    const memberCount = await query<{ n: string }>(
      "SELECT count(*)::text AS n FROM app_members WHERE app_id = $1 AND status = 'active'",
      [row.id]
    );
    const deps = await recentDeployments(row.id, 5);

    const status: AppStatus = {
      app: await appSummary(row),
      manifestSummary: {
        runtimeAdapter: m.runtime.adapter,
        port: m.runtime.port,
        healthPath: m.runtime.healthPath,
        capabilities: m.capabilities as unknown as Record<string, boolean>,
      },
      database: {
        enabled: m.capabilities.database,
        provisioned: await isDatabaseProvisioned(row.id),
      },
      storage: {
        enabled: m.capabilities.storage,
        provisioned: await isStorageProvisioned(row.id),
      },
      members: Number(memberCount.rows[0]?.n ?? "0"),
      recentDeployments: deps.map(deploymentToContract),
    };
    return reply.send({ status });
  });
}
