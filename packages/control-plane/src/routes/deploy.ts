import type { FastifyInstance } from "fastify";
import type { AppEnvironment } from "@vibe/shared";
import { query } from "../db.js";
import { audit } from "../lib/audit.js";
import { shortId } from "../lib/ids.js";
import { loadConfig } from "../config.js";
import {
  buildImage,
  cleanupContext,
  containerLogs,
  extractContext,
  pullImage,
  removeContainer,
  runContainer,
  runOneOff,
  stopContainer,
} from "../services/docker.js";
import { ensureDockerfile } from "../services/runtime.js";
import { provisionDatabase } from "../services/dbProvision.js";
import { emailEnvFor } from "../services/email.js";
import { provisionStorage, storageEnvFor } from "../services/storage.js";
import { upsertAppRoute } from "../services/caddy.js";
import {
  deploymentToContract,
  ensureAppEnvironment,
  envSubdomain,
  getApp,
  getAppEnvironment,
  getAppRepo,
  getDeployment,
  recentDeployments,
  type AppRow,
} from "../repo.js";
import { createDeployment, setDeploymentStatus } from "../services/github.js";
import { requireOwner } from "./guards.js";

function normalizeEnv(value: unknown, fallback: AppEnvironment = "prod"): AppEnvironment {
  if (value === "test" || value === "prod") return value;
  return fallback;
}

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

/**
 * Where a deployment's image comes from:
 *  - "context": build it on the VPS from an uploaded tar (repo-less apps).
 *  - "image":   pull a prebuilt image (GitHub Actions → ghcr.io).
 */
type DeploySource =
  | { kind: "context"; tarPath: string }
  | {
      kind: "image";
      image: string;
      /** When set, mirror rollout state back to a GitHub Deployment. */
      github?: { repo: string; deploymentId: number };
    };

/** Best-effort GitHub Deployment status update; never throws into the pipeline. */
async function reportGithub(
  source: DeploySource,
  state: "success" | "failure",
  environmentUrl?: string
): Promise<void> {
  if (source.kind !== "image" || !source.github) return;
  try {
    await setDeploymentStatus(
      source.github.repo,
      source.github.deploymentId,
      state,
      { environmentUrl }
    );
  } catch {
    // GitHub status is non-critical; the deploy already succeeded or failed.
  }
}

async function enqueueVerifyJob(
  app: AppRow,
  ownerEmail: string,
  environment: AppEnvironment
): Promise<void> {
  const cfg = loadConfig();
  const appUrl = `https://${envSubdomain(app.subdomain, environment)}.${cfg.appsDomain}`;
  const instruction = JSON.stringify({ appUrl, ownerEmail, environment });
  const id = shortId("job");
  await query(
    `INSERT INTO jobs (id, kind, target_app, instruction, owner_email, status, llm_provider, llm_model)
     VALUES ($1, 'verify', $2, $3, $4, 'queued', 'claude', 'sonnet')`,
    [id, app.id, instruction, ownerEmail]
  );
}

/** The full deploy pipeline, run in the background after the route returns. */
async function runDeploy(
  app: AppRow,
  deploymentId: string,
  source: DeploySource,
  environment: AppEnvironment,
  ownerEmail?: string
): Promise<void> {
  const m = app.manifest;
  const envSuffix = environment === "prod" ? "" : `-${environment}`;
  const container = `vibe-${app.id}${envSuffix}-${deploymentId.replace(/[^a-z0-9]/g, "")}`;
  const port = m.runtime.port;
  let contextDir: string | null = null;

  const appEnv = await ensureAppEnvironment(app.id, environment);
  const prevDeployId =
    appEnv.current_deployment_id ?? (environment === "prod" ? app.current_deployment_id : null);
  const prevDeploy = prevDeployId ? await getDeployment(prevDeployId) : null;

  try {
    await setDeploy(deploymentId, { status: "building", container_name: container, port });

    // Resolve the image: pull a prebuilt one, or build from the uploaded context.
    let imageTag: string;
    if (source.kind === "image") {
      imageTag = source.image;
      await appendLog(deploymentId, `[vibe] pulling ${imageTag}`);
      const pull = await pullImage(imageTag);
      await appendLog(deploymentId, `$ docker pull ${imageTag}\n${pull.stdout}\n${pull.stderr}`);
      if (pull.code !== 0) throw new Error(`docker pull failed for ${imageTag}`);
    } else {
      imageTag = `vibe/${app.id}:${deploymentId.replace(/[^a-z0-9]/g, "")}`;
      contextDir = await extractContext(source.tarPath);
      const { dockerfile, generated } = await ensureDockerfile(contextDir, m);
      if (generated) await appendLog(deploymentId, `[vibe] generated ${dockerfile} for adapter ${m.runtime.adapter}`);
      const build = await buildImage(contextDir, imageTag, dockerfile);
      await appendLog(deploymentId, build.log);
      if (!build.ok) throw new Error("docker build failed");
    }
    await setDeploy(deploymentId, { image_tag: imageTag });

    // Provision backend capabilities and assemble the container environment.
    const env: Record<string, string> = {
      ...(await userEnv(app.id)),
      VIBE_APP_ID: app.id,
      VIBE_APP_NAME: app.name,
      VIBE_ENV: environment,
      NODE_ENV: environment === "prod" ? "production" : "test",
    };
    if (m.capabilities.database) {
      env.DATABASE_URL = await provisionDatabase(app.id, environment);
    }
    if (m.capabilities.storage) {
      await provisionStorage(app.id, environment);
      Object.assign(env, (await storageEnvFor(app.id, environment)) ?? {});
    }
    if (m.capabilities.email) {
      if (environment === "prod") {
        const emailEnv = emailEnvFor();
        if (emailEnv) Object.assign(env, emailEnv);
        else await appendLog(deploymentId, "[vibe] email capability enabled but no platform SMTP configured — skipping");
      } else {
        env.EMAIL_CAPTURE = "true";
        await appendLog(deploymentId, "[vibe] test environment: real email provider disabled; EMAIL_CAPTURE=true");
      }
    }
    if (m.capabilities.llm) {
      const cfg = loadConfig();
      env.VIBE_CONTROL_URL = `https://${cfg.controlPlaneDomain}`;
      env.VIBE_OWNER_TOKEN = cfg.ownerToken;
    }

    // Migrations (run as a one-off before the new container takes traffic).
    if (m.capabilities.database && m.database?.migrations) {
      await setDeploy(deploymentId, { status: "migrating" });
      const mig = await runOneOff(imageTag, env, port, m.database.migrations);
      await appendLog(deploymentId, `[migrate]\n${mig.stdout}\n${mig.stderr}`);
      if (mig.code !== 0) throw new Error("migration failed");
    }

    if (m.capabilities.database && m.database?.seed) {
      if (environment === "test") {
        await setDeploy(deploymentId, { status: "migrating" });
        const seed = await runOneOff(imageTag, env, port, m.database.seed);
        await appendLog(deploymentId, `[seed:test]\n${seed.stdout}\n${seed.stderr}`);
        if (seed.code !== 0) throw new Error("seed failed");
      } else {
        await appendLog(deploymentId, "[vibe] database.seed is test-only; skipping for production");
      }
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
    await upsertAppRoute(
      app.id,
      envSubdomain(app.subdomain, environment),
      container,
      port,
      environment
    );
    await setDeploy(deploymentId, {
      status: "live",
      health: "healthy",
      completed_at: new Date(),
      rollback_target: prevDeploy?.container_name ?? null,
    });
    await query(
      `UPDATE app_environments
       SET status = 'live', current_deployment_id = $3, updated_at = now()
       WHERE app_id = $1 AND environment = $2`,
      [app.id, environment, deploymentId]
    );
    if (environment === "prod") {
      await query(
        "UPDATE apps SET status = 'live', current_deployment_id = $2, updated_at = now() WHERE id = $1",
        [app.id, deploymentId]
      );
    }

    if (ownerEmail) await enqueueVerifyJob(app, ownerEmail, environment);

    if (prevDeploy?.container_name && prevDeploy.container_name !== container) {
      // Keep it stopped (not removed) so `vibe deploy rollback` can revive it.
      await stopContainer(prevDeploy.container_name);
    }

    await audit({ action: "deploy.success", appId: app.id, detail: { deploymentId, environment } });
    await reportGithub(
      source,
      "success",
      `https://${envSubdomain(app.subdomain, environment)}.${loadConfig().appsDomain}`
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await setDeploy(deploymentId, {
      status: "failed",
      health: "unhealthy",
      error: message,
      completed_at: new Date(),
    });
    await query(
      `UPDATE app_environments
       SET status = 'failed', updated_at = now()
       WHERE app_id = $1 AND environment = $2`,
      [app.id, environment]
    );
    await audit({
      action: "deploy.failed",
      appId: app.id,
      success: false,
      detail: { deploymentId, environment, message },
    });
    await reportGithub(source, "failure");
  } finally {
    if (contextDir) await cleanupContext(contextDir);
  }
}

export async function deployRoutes(app: FastifyInstance): Promise<void> {
  // Kick off a deploy from an uploaded build context (application/gzip body).
  app.post<{ Params: { id: string }; Querystring: { env?: string }; Body: { tarPath: string } }>(
    "/api/apps/:id/deploy",
    async (req, reply) => {
      const actor = await requireOwner(req, reply);
      if (!actor) return;
      const appRow = await getApp(req.params.id);
      if (!appRow) return reply.code(404).send({ error: "app not found" });
      const environment = normalizeEnv(req.query.env, "test");
      await ensureAppEnvironment(appRow.id, environment);

      const { tarPath } = req.body ?? {};
      if (!tarPath) return reply.code(400).send({ error: "expected application/gzip build context" });

      const deploymentId = shortId("dep");
      await query(
        "INSERT INTO deployments (id, app_id, environment, status) VALUES ($1, $2, $3, 'queued')",
        [deploymentId, appRow.id, environment]
      );
      await audit({ actorEmail: actor.email, action: "deploy.start", appId: appRow.id, detail: { deploymentId, environment } });

      // Run the pipeline in the background; client polls the deployment.
      void runDeploy(appRow, deploymentId, { kind: "context", tarPath }, environment, actor.email);

      return reply.code(202).send({ deploymentId, appId: appRow.id });
    }
  );

  // Deploy a prebuilt image (GitHub Actions builds + pushes, then calls this).
  app.post<{
    Params: { id: string };
    Body: { image?: string; sha?: string; ref?: string; env?: string };
  }>("/api/apps/:id/deploy/image", async (req, reply) => {
    const actor = await requireOwner(req, reply);
    if (!actor) return;
    const appRow = await getApp(req.params.id);
    if (!appRow) return reply.code(404).send({ error: "app not found" });

    const { image, sha, ref } = req.body ?? {};
    const environment = normalizeEnv(req.body?.env, "test");
    await ensureAppEnvironment(appRow.id, environment);
    if (!image) return reply.code(400).send({ error: "expected { image } in body" });

    const deploymentId = shortId("dep");
    await query(
      `INSERT INTO deployments (id, app_id, environment, status, source, git_sha, git_ref)
       VALUES ($1, $2, $3, 'queued', 'image', $4, $5)`,
      [deploymentId, appRow.id, environment, sha ?? null, ref ?? null]
    );
    await audit({
      actorEmail: actor.email,
      action: "deploy.start",
      appId: appRow.id,
      detail: { deploymentId, environment, image, sha },
    });

    // If the app has a linked repo and we know the commit, open a GitHub
    // Deployment so the rollout shows up in the repo's Deployments tab.
    let github: { repo: string; deploymentId: number } | undefined;
    const linked = await getAppRepo(appRow.id);
    const gitRef = sha ?? ref;
    if (linked && gitRef) {
      try {
        const ghId = await createDeployment(linked.repo_full_name, gitRef, environment);
        await setDeploymentStatus(linked.repo_full_name, ghId, "in_progress");
        github = { repo: linked.repo_full_name, deploymentId: ghId };
      } catch (err) {
        req.log.warn(`[github] could not open deployment: ${(err as Error).message}`);
      }
    }

    void runDeploy(appRow, deploymentId, { kind: "image", image, github }, environment, actor.email);

    return reply.code(202).send({ deploymentId, appId: appRow.id });
  });

  app.post<{
    Params: { id: string };
    Body: { from?: string; to?: string };
  }>("/api/apps/:id/promote", async (req, reply) => {
    const actor = await requireOwner(req, reply);
    if (!actor) return;
    const appRow = await getApp(req.params.id);
    if (!appRow) return reply.code(404).send({ error: "app not found" });

    const from = normalizeEnv(req.body?.from ?? "test");
    const to = normalizeEnv(req.body?.to ?? "prod");
    if (from === to) return reply.code(400).send({ error: "from and to environments must differ" });

    const sourceEnv = await getAppEnvironment(appRow.id, from);
    const sourceDep = sourceEnv?.current_deployment_id
      ? await getDeployment(sourceEnv.current_deployment_id)
      : null;
    if (!sourceDep?.image_tag || sourceDep.status !== "live") {
      return reply.code(409).send({ error: `${from} has no live deployment image to promote` });
    }

    await ensureAppEnvironment(appRow.id, to);
    const deploymentId = shortId("dep");
    await query(
      `INSERT INTO deployments (id, app_id, environment, status, source, image_tag, git_sha, git_ref)
       VALUES ($1, $2, $3, 'queued', 'image', $4, $5, $6)`,
      [deploymentId, appRow.id, to, sourceDep.image_tag, sourceDep.git_sha, sourceDep.git_ref]
    );
    await audit({
      actorEmail: actor.email,
      action: "deploy.promote",
      appId: appRow.id,
      detail: { deploymentId, from, to, image: sourceDep.image_tag },
    });

    void runDeploy(appRow, deploymentId, { kind: "image", image: sourceDep.image_tag }, to, actor.email);
    return reply.code(202).send({ deploymentId, appId: appRow.id });
  });

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

  app.get<{ Params: { id: string }; Querystring: { env?: string } }>(
    "/api/apps/:id/deployments",
    async (req, reply) => {
      const actor = await requireOwner(req, reply);
      if (!actor) return;
      const rows = await recentDeployments(req.params.id, normalizeEnv(req.query.env), 20);
      return reply.send({ deployments: rows.map(deploymentToContract) });
    }
  );

  // Runtime + build logs for the current (or specified) deployment.
  app.get<{ Params: { id: string }; Querystring: { build?: string; tail?: string; env?: string } }>(
    "/api/apps/:id/logs",
    async (req, reply) => {
      const actor = await requireOwner(req, reply);
      if (!actor) return;
      const appRow = await getApp(req.params.id);
      if (!appRow) return reply.code(404).send({ error: "app not found" });
      const environment = normalizeEnv(req.query.env);
      const appEnv = await getAppEnvironment(appRow.id, environment);
      const currentId = appEnv?.current_deployment_id ?? (environment === "prod" ? appRow.current_deployment_id : null);
      const dep = currentId
        ? await getDeployment(currentId)
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
  app.post<{ Params: { id: string }; Body: { env?: string } }>(
    "/api/apps/:id/rollback",
    async (req, reply) => {
      const actor = await requireOwner(req, reply);
      if (!actor) return;
      const appRow = await getApp(req.params.id);
      if (!appRow) return reply.code(404).send({ error: "app not found" });
      const environment = normalizeEnv(req.body?.env);
      const appEnv = await getAppEnvironment(appRow.id, environment);
      const currentId = appEnv?.current_deployment_id ?? (environment === "prod" ? appRow.current_deployment_id : null);
      const cur = currentId ? await getDeployment(currentId) : null;
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
      await upsertAppRoute(appRow.id, envSubdomain(appRow.subdomain, environment), target, port, environment);
      if (prev.rows[0]) {
        await query(
          `UPDATE app_environments
           SET status = 'live', current_deployment_id = $3, updated_at = now()
           WHERE app_id = $1 AND environment = $2`,
          [appRow.id, environment, prev.rows[0].id]
        );
        if (environment === "prod") {
          await query("UPDATE apps SET current_deployment_id = $2 WHERE id = $1", [
            appRow.id,
            prev.rows[0].id,
          ]);
        }
      }
      await audit({ actorEmail: actor.email, action: "deploy.rollback", appId: appRow.id, detail: { environment } });
      return reply.send({ rolledBackTo: target });
    }
  );
}
