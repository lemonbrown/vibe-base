import { query } from "../db.js";
import { audit } from "../lib/audit.js";
import { getApp, getAppRepo } from "../repo.js";
import { removeAppRoute } from "./caddy.js";
import { deprovisionDatabase } from "./dbProvision.js";
import { removeContainer, removeImage } from "./docker.js";
import { deleteGhcrPackage, deleteRepo, githubEnabled } from "./github.js";
import { closeAppPool } from "./query.js";
import { deprovisionStorage } from "./storage.js";

/**
 * Permanently delete an app and every resource it owns on the VPS:
 *   1. its Caddy route (stop serving traffic first),
 *   2. every container it ever ran + the images built for it,
 *   3. its dedicated Postgres database + login role,
 *   4. its storage bucket and all objects,
 *   5. all platform records (child tables cascade from `apps`).
 *
 * Pass `{ deleteGithub: true }` to also delete the linked GitHub repository
 * and its GHCR container package (best-effort, does not fail the teardown).
 *
 * The order matters: routing is removed before the containers it points at,
 * and the `apps` row is deleted last so a mid-way failure leaves the app
 * still listed (and retry-able) rather than orphaning live infrastructure.
 */
export async function destroyApp(
  appId: string,
  actorEmail: string,
  opts: { deleteGithub?: boolean } = {}
): Promise<void> {
  const app = await getApp(appId);
  if (!app) return;

  // Fetch repo link now — app_repos cascades when the apps row is deleted below.
  const repo = opts.deleteGithub ? await getAppRepo(appId) : null;

  // 1. Stop routing so no request hits a container we're about to remove.
  await removeAppRoute(appId);
  await removeAppRoute(appId, "test");

  // 2. Remove every container (current + historical) and the images built for
  //    them. `rm -f` covers running and stopped containers alike.
  const deps = await query<{
    container_name: string | null;
    image_tag: string | null;
  }>("SELECT container_name, image_tag FROM deployments WHERE app_id = $1", [
    appId,
  ]);
  const containers = new Set<string>();
  const images = new Set<string>();
  for (const d of deps.rows) {
    if (d.container_name) containers.add(d.container_name);
    if (d.image_tag) images.add(d.image_tag);
  }
  for (const name of containers) await removeContainer(name);
  for (const ref of images) await removeImage(ref);

  // 3 + 4. Drop the dedicated database/role and the storage bucket. Close any
  //         cached read-model connection pool first so we aren't holding open
  //         sessions against the database we're about to drop.
  await closeAppPool(appId);
  const dbEnvs = await query<{ environment: "test" | "prod" }>(
    "SELECT environment FROM db_provisions WHERE app_id = $1",
    [appId]
  );
  for (const row of dbEnvs.rows) await deprovisionDatabase(appId, row.environment);
  const storageEnvs = await query<{ environment: "test" | "prod" }>(
    "SELECT environment FROM storage_provisions WHERE app_id = $1",
    [appId]
  );
  for (const row of storageEnvs.rows) await deprovisionStorage(appId, row.environment);

  // 5. Remove all platform records. deployments, db_provisions,
  //    storage_provisions, env_vars, app_members, invites and app_repos all
  //    declare ON DELETE CASCADE against apps(id).
  await query("DELETE FROM apps WHERE id = $1", [appId]);

  // Queue a local folder cleanup for any daemon that has this app checked out.
  await query(
    "INSERT INTO pending_cleanups (app_id) VALUES ($1) ON CONFLICT DO NOTHING",
    [appId]
  );

  await audit({ actorEmail, action: "app.delete", appId });

  // 6. Optionally remove the GitHub repo and its GHCR package. Done after
  //    platform cleanup so a GitHub API error never leaves orphaned infra.
  if (repo && githubEnabled()) {
    try {
      await deleteGhcrPackage(repo.repo_full_name);
    } catch { /* best-effort */ }
    try {
      await deleteRepo(repo.repo_full_name);
    } catch { /* best-effort */ }
  }
}
