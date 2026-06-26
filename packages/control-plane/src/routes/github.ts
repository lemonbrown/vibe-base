import type { FastifyInstance } from "fastify";
import { loadConfig } from "../config.js";
import { audit } from "../lib/audit.js";
import { getApp, getAppRepo, upsertAppRepo } from "../repo.js";
import {
  createRepo,
  setActionsSecret,
  setActionsVariable,
  setDefaultWorkflowPermissions,
} from "../services/github.js";
import { requireOwner } from "./guards.js";

export async function githubRoutes(app: FastifyInstance): Promise<void> {
  // Create a GitHub repo for an app and wire its Actions to deploy here.
  app.post<{
    Params: { id: string };
    Body: { name?: string; private?: boolean };
  }>("/api/apps/:id/github/repo", async (req, reply) => {
    const actor = await requireOwner(req, reply);
    if (!actor) return;
    const appRow = await getApp(req.params.id);
    if (!appRow) return reply.code(404).send({ error: "app not found" });

    const cfg = loadConfig();
    if (!cfg.github.token) {
      return reply.code(400).send({ error: "GitHub integration not configured (set GITHUB_TOKEN)" });
    }

    const name = req.body?.name ?? appRow.id;
    let repo;
    try {
      repo = await createRepo({
        name,
        description: appRow.description,
        private: req.body?.private ?? true,
      });
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }

    // Best-effort: give CI what it needs to call the deploy-image endpoint.
    // The repo already exists, so don't fail the request if this part does.
    try {
      await setActionsSecret(repo.fullName, "VIBE_DEPLOY_TOKEN", cfg.ownerToken);
      await setActionsVariable(repo.fullName, "VIBE_API_URL", `https://${cfg.controlPlaneDomain}`);
      await setActionsVariable(repo.fullName, "VIBE_APP_ID", appRow.id);
      await setActionsVariable(repo.fullName, "VIBE_DEPLOY_ENV", "test");
      // Let the workflow's GITHUB_TOKEN push the built image to GHCR.
      await setDefaultWorkflowPermissions(repo.fullName, "write");
    } catch (err) {
      req.log.warn(`[github] could not set Actions config: ${(err as Error).message}`);
    }

    await upsertAppRepo({
      appId: appRow.id,
      repoFullName: repo.fullName,
      defaultBranch: repo.defaultBranch,
      htmlUrl: repo.htmlUrl,
    });
    await audit({
      actorEmail: actor.email,
      action: "github.repo.create",
      appId: appRow.id,
      detail: { repo: repo.fullName },
    });

    return reply.send({
      repo: repo.fullName,
      cloneUrl: repo.cloneUrl,
      sshUrl: repo.sshUrl,
      htmlUrl: repo.htmlUrl,
      defaultBranch: repo.defaultBranch,
    });
  });

  // Inspect the repo link for an app.
  app.get<{ Params: { id: string } }>(
    "/api/apps/:id/github",
    async (req, reply) => {
      const actor = await requireOwner(req, reply);
      if (!actor) return;
      const link = await getAppRepo(req.params.id);
      if (!link) return reply.code(404).send({ error: "no repo linked" });
      return reply.send({
        repo: link.repo_full_name,
        defaultBranch: link.default_branch,
        htmlUrl: link.html_url,
      });
    }
  );
}
