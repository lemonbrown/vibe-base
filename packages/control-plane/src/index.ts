import { ensureOwner } from "./bootstrap.js";
import { loadConfig } from "./config.js";
import { closePool } from "./db.js";
import { runMigrations } from "./migrations.js";
import { buildServer } from "./server.js";
import { ensureBaseConfig } from "./services/caddy.js";

async function main(): Promise<void> {
  const cfg = loadConfig();
  await runMigrations();
  await ensureOwner();

  // Best-effort: program Caddy's base config. Don't block startup if the
  // proxy isn't reachable yet (e.g. local dev without Caddy).
  try {
    await ensureBaseConfig();
  } catch (err) {
    console.warn("[caddy] base config skipped:", (err as Error).message);
  }

  const app = await buildServer();
  await app.listen({ host: "0.0.0.0", port: cfg.port });
  app.log.info(`vibe control plane on :${cfg.port} (apps: *.${cfg.appsDomain})`);

  const shutdown = async () => {
    await app.close();
    await closePool();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("fatal:", err);
  process.exit(1);
});
