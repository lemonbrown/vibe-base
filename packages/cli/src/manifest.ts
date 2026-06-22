import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseManifest, type Manifest } from "@vibe/shared";
import YAML from "yaml";

export const MANIFEST_FILE = "vibe.app.yaml";

export function manifestPath(cwd: string): string {
  return join(cwd, MANIFEST_FILE);
}

export async function hasManifest(cwd: string): Promise<boolean> {
  try {
    await access(manifestPath(cwd));
    return true;
  } catch {
    return false;
  }
}

export async function loadManifest(cwd: string): Promise<Manifest> {
  let raw: string;
  try {
    raw = await readFile(manifestPath(cwd), "utf8");
  } catch {
    throw new Error(
      `No ${MANIFEST_FILE} found in this directory. Run \`vibe init\` first.`
    );
  }
  return parseManifest(YAML.parse(raw));
}

export async function saveManifest(cwd: string, manifest: Manifest): Promise<void> {
  await writeFile(manifestPath(cwd), YAML.stringify(manifest), "utf8");
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "app";
}
