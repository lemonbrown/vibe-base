import type { FastifyInstance } from "fastify";
import { query } from "../db.js";
import { audit } from "../lib/audit.js";
import { shortId } from "../lib/ids.js";
import { loadConfig } from "../config.js";
import {
  buildImage,
  cleanupContext,
  containerLogs,
  extractContext,
  removeContainer,
  runContainer,
  runOneOff,
  stopContainer,
} from "../services/docker.js";
import { ensureDockerfile } from "../services/runtime.js";
import { provisionDatabase } from "../services/dbProvision.js";
import { provisionStorage, storageEnvFor } from "../services/storage.js";
import { upsertAppRoute } from "../services/caddy.js";
import {
  deploymentToContract,
  getApp,
  getDeployment,
  recentDeployments,
  type AppRow,
} from "../repo.js";
import { requireOwner } from "./guards.js";

async function setDeploy(
  id: string,
  fields: Record<string, unknown>
): Promise<void> {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(", ");
  await query(`UPDATE deployments SET ${sets} WHERE id = $1`, [
    id,
    ...keys.map((k) => fields[k]),
  ]);
}

async function appendLog(id: string, chunk: string): Promise<void> {
  await query(
    "UPDATE deployments SET build_log = build_log || $2 WHERE id = $1",
    [id, chunk + "\n"]
  );
}

async function userEnv(appId: string): Promise<Record<string, string>> {
  const res = await query<{ key: string; value: string }>(
    "SELECT key, value FROM env_vars WHERE app_id = $1",
    [appId]
  );
  const env: Record<string, string> = {};
  for (const r of res.rows) env[r.key] = r.value;
  return env;
}

async function waitHealthy(
  container: string,
  port: number,
  healthPath: string,
  attempts = 40
): Promise<boolean> {
  const url = `http://${container}:${port}${healthPath}`;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return false;
}

/** The full deploy pipeline, run in the background after the route returns. */
async function runDeploy(
  app: AppRow,
  deploymentId: string,
  tarPath: string
): Promise<void> {
  const m = app.manifest;
  const container = `vibe-${app.id}-${deploymentId.replace(/[^a-z0-9]/g, "")}`;
  const imageTag = `vibe/${app.id}:${deploymentId.replace(/[^a-z0-9]/g, "")}`;
  const port = m.runtime.port;
  let contextDir: string | null = null;

  const prevDeployId = app.current_deployment_id;
  const prevDeploy = prevDeployId ? await getDeployment(prevDeployId) : null;

  try {
    await setDeploy(deploymentId, { status: "building", container_name: container, port });
    contextDir = await extractContext(tarPath);

    const { dockerfile, generated } = await ensureDockerfile(contextDir, m);
    if (generated) await appendLog(deploymentId, `[vibe] generated ${dockerfile} for adapter ${m.runtime.adapter}`);

    const build = await buildImage(contextDir, imageTag, dockerfile);
    await appendLog(deploymentId, build.log);
    if (!build.ok) throw new Error("docker build failed");

    // Provision backend capabilities and assemble the container environment.
    const env: Record<string, string> = {
      VIBE_APP_ID: app.id,
      VIBE_APP_NAME: app.name,
      ...(await userEnv(app.id)),
    };
    if (m.capabilities.database) {
      env.DATABASE_URL = await provisionDatabase(app.id);
    }
    if (m.capabilities.storage) {
      await provisionStorage(app.id);
      Object.assign(env, (await storageEnvFor(app.id)) ?? {});
    }

    // Migrations (run as a one-off before the new container takes traffic).
    if (m.capabilities.database && m.database?.migrations) {
      await setDeploy(deploymentId, { status: "migrating" });
      const mig = await runOneOff(imageTag, env, port, m.database.migrations);
      await appendLog(deploymentId, `[migrate]\n${mig.stdout}\n${mig.stderr}`);
      if (mig.code !== 0) throw new Error("migration failed");
    }

    await setDeploy(deploymentId, { status: "starting" });
    const run = await runContainer({ imageTag, name: container, env, port });
    if (run.code !== 0) {
      await appendLog(deploymentId, run.stderr);
      throw new Error("container failed to start");
    }

    await setDeploy(deploymentId, { status: "health_check" });
    const healthy = await waitHealthy(container, port, m.runtime.healthPath);
    if (!healthy) {
      await appendLog(deploymentId, await containerLogs(container));
      await removeContainer(container);
      throw new Error(`health check failed at ${m.runtime.healthPath}`);
    }

    // Flip the proxy to the new container, then retire the old one.
    await upsertAppRoute(app.id, app.subdomain, container, port);
    await setDeploy(deploymentId, {
      status: "live",
      health: "healthy",
      completed_at: new Date(),
      rollback_target: prevDeploy?.container_name ?? null,
    });
    await query(
      "UPDATE apps SET status = 'live', current_deployment_id = $2, updated_at = now() WHERE id = $1",
      [app.id, deploymentId]
    );

    if (prevDeploy?.container_name && prevDeploy.container_name !== container) {
      // Keep it stopped (not removed) so `vibe deploy rollback` can revive it.
      await stopContainer(prevDeploy.container_name);
    }

    await audit({ action: "deploy.success", appId: app.id, detail: { deploymentId } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await setDeploy(deploymentId, {
      status: "failed",
      health: "unhealthy",
      error: message,
      completed_at: new Date(),
    });
    await audit({
      action: "deploy.failed",
      appId: app.id,
      success: false,
      detail: { deploymentId, message },
    });
  } finally {
    if (contextDir) await cleanupContext(contextDir);
  }
}

export async function deployRoutes(app: FastifyInstance): Promise<void> {
  // Kick off a deploy from an uploaded build context (application/gzip body).
  app.post<{ Params: { id: string }; Body: { tarPath: string } }>(
    "/api/apps/:id/deploy",
    async (req, reply) => {
      const actor = await requireOwner(req, reply);
      if (!actor) return;
      const appRow = await getApp(req.params.id);
      if (!appRow) return reply.code(404).send({ error: "app not found" });

      const { tarPath } = req.body ?? {};
      if (!tarPath) return reply.code(400).send({ error: "expected application/gzip build context" });

      const deploymentId = shortId("dep");
      await query(
        "INSERT INTO deployments (id, app_id, status) VALUES ($1, $2, 'queued')",
        [deploymentId, appRow.id]
      );
      await audit({ actorEmail: actor.email, action: "deploy.start", appId: appRow.id, detail: { deploymentId } });

      // Run the pipeline in the background; client polls the deployment.
      void runDeploy(appRow, deploymentId, tarPath);

      return reply.code(202).send({ deploymentId, appId: appRow.id });
    }
  );

  app.get<{ Params: { id: string } }>(
    "/api/deployments/:id",
    async (req, reply) => {
      const actor = await requireOwner(req, reply);
      if (!actor) return;
      const dep = await getDeployment(req.params.id);
      if (!dep) return reply.code(404).send({ error: "deployment not found" });
      return reply.send({ deployment: deploymentToContract(dep), buildLog: dep.build_log });
    }
  );

  app.get<{ Params: { id: string } }>(
    "/api/apps/:id/deployments",
    async (req, reply) => {
      const actor = await requireOwner(req, reply);
      if (!actor) return;
      const rows = await recentDeployments(req.params.id, 20);
      return reply.send({ deployments: rows.map(deploymentToContract) });
    }
  );

  // Runtime + build logs for the current (or specified) deployment.
  app.get<{ Params: { id: string }; Querystring: { build?: string; tail?: string } }>(
    "/api/apps/:id/logs",
    async (req, reply) => {
      const actor = await requireOwner(req, reply);
      if (!actor) return;
      const appRow = await getApp(req.params.id);
      if (!appRow) return reply.code(404).send({ error: "app not found" });
      const dep = appRow.current_deployment_id
        ? await getDeployment(appRow.current_deployment_id)
        : null;
      if (req.query.build) {
        return reply.send({ log: dep?.build_log ?? "" });
      }
      const tail = Number(req.query.tail ?? "200");
      const log = dep?.container_name ? await containerLogs(dep.container_name, tail) : "";
      return reply.send({ log });
    }
  );

  // Rollback: revive the previous container and re-point the route.
  app.post<{ Params: { id: string } }>(
    "/api/apps/:id/rollback",
    async (req, reply) => {
      const actor = await requireOwner(req, reply);
      if (!actor) return;
      const appRow = await getApp(req.params.id);
      if (!appRow) return reply.code(404).send({ error: "app not found" });
      const cur = appRow.current_deployment_id ? await getDeployment(appRow.current_deployment_id) : null;
      const target = cur?.rollback_target;
      if (!target) return reply.code(409).send({ error: "no rollback target available" });

      const { execFileSync } = await import("node:child_process");
      try {
        execFileSync("docker", ["start", target]);
      } catch {
        return reply.code(500).send({ error: "could not start previous container" });
      }
      const prev = await query<{ id: string; port: number | null }>(
        "SELECT id, port FROM deployments WHERE container_name = $1 ORDER BY created_at DESC LIMIT 1",
        [target]
      );
      const port = prev.rows[0]?.port ?? loadConfig().port;
      await upsertAppRoute(appRow.id, appRow.subdomain, target, port);
      if (prev.rows[0]) {
        await query("UPDATE apps SET current_deployment_id = $2 WHERE id = $1", [
          appRow.id,
          prev.rows[0].id,
        ]);
      }
      await audit({ actorEmail: actor.email, action: "deploy.rollback", appId: appRow.id });
      return reply.send({ rolledBackTo: target });
    }
  );
}
