import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { generateDockerfile, type Manifest } from "@vibe/shared";

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure the build context has a Dockerfile. If the app brings its own
 * (adapter custom-dockerfile, or a Dockerfile is present), use it.
 * Otherwise generate one from the declared runtime adapter.
 *
 * Returns the Dockerfile filename relative to the context dir.
 */
export async function ensureDockerfile(
  contextDir: string,
  manifest: Manifest
): Promise<{ dockerfile: string; generated: boolean }> {
  const declared = manifest.runtime.dockerfile ?? "Dockerfile";

  if (await exists(join(contextDir, declared))) {
    return { dockerfile: declared, generated: false };
  }
  if (manifest.runtime.adapter === "custom-dockerfile") {
    throw new Error(
      `adapter is custom-dockerfile but '${declared}' was not found in the build context`
    );
  }

  const generated = generateDockerfile(manifest);
  const name = "Dockerfile.vibe";
  await writeFile(join(contextDir, name), generated, "utf8");
  return { dockerfile: name, generated: true };
}
