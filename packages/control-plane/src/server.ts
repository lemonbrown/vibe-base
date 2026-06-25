import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import cookie from "@fastify/cookie";
import formbody from "@fastify/formbody";
import Fastify, { type FastifyInstance } from "fastify";
import { loadConfig } from "./config.js";
import { shortId } from "./lib/ids.js";
import { agentRoutes } from "./routes/agent.js";
import { appLlmRoutes } from "./routes/appLlm.js";
import { appRoutes } from "./routes/apps.js";
import { authRoutes } from "./routes/auth.js";
import { chatRoutes } from "./routes/chat.js";
import { deployRoutes } from "./routes/deploy.js";
import { githubRoutes } from "./routes/github.js";
import { memberRoutes } from "./routes/members.js";
import { portalMemberRoutes } from "./routes/portalMembers.js";
import { portalRoutes } from "./routes/portal.js";
import { queryRoutes } from "./routes/query.js";
import { settingsRoutes } from "./routes/settings.js";
import { statusRoutes } from "./routes/status.js";

/** Body parser for deploy uploads: stream the gzipped tar to a temp file. */
async function registerTarballParser(app: FastifyInstance): Promise<void> {
  const uploadDir = join(tmpdir(), "vibe-uploads");
  await mkdir(uploadDir, { recursive: true });

  app.addContentTypeParser(
    "application/gzip",
    (_req, payload, done) => {
      const tarPath = join(uploadDir, `${shortId("up")}.tar.gz`);
      pipeline(payload, createWriteStream(tarPath))
        .then(() => done(null, { tarPath }))
        .catch((err) => done(err as Error));
    }
  );
}

export async function buildServer(): Promise<FastifyInstance> {
  const cfg = loadConfig();
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? "info" },
    bodyLimit: 512 * 1024 * 1024, // 512MB build context cap
    trustProxy: true,
  });

  await app.register(cookie, { secret: cfg.sessionSecret });
  await app.register(formbody);
  await registerTarballParser(app);

  app.get("/health", async () => ({ ok: true, service: "vibe-control-plane" }));

  await app.register(authRoutes);
  await app.register(appRoutes);
  await app.register(deployRoutes);
  await app.register(githubRoutes);
  await app.register(memberRoutes);
  await app.register(portalMemberRoutes);
  await app.register(statusRoutes);
  await app.register(queryRoutes);
  await app.register(agentRoutes);
  await app.register(appLlmRoutes);
  await app.register(chatRoutes);
  await app.register(settingsRoutes);
  await app.register(portalRoutes);

  return app;
}
