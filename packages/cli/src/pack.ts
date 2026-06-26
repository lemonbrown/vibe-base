import * as tar from "tar";

const EXCLUDE = [
  "node_modules",
  ".git",
  ".next",
  "dist",
  "tmp",
  ".env",
  ".env.local",
  ".DS_Store",
];

const EXCLUDE_EXTENSIONS = [
  ".db",
  ".db-shm",
  ".db-wal",
  ".sqlite",
  ".sqlite3",
  ".sqlite-shm",
  ".sqlite-wal",
  ".sqlite3-shm",
  ".sqlite3-wal",
];

function excluded(path: string): boolean {
  const parts = path.replace(/^\.\//, "").split("/");
  if (parts.some((p) => EXCLUDE.includes(p))) return true;
  if (path.endsWith(".log")) return true;
  if (EXCLUDE_EXTENSIONS.some((ext) => path.endsWith(ext))) return true;
  if (path.endsWith(".vibe/state.json")) return true;
  return false;
}

/** Tar+gzip the project directory into an in-memory build context. */
export async function packProject(cwd: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const stream = tar.c(
    {
      gzip: true,
      cwd,
      filter: (path) => !excluded(path),
      portable: true,
    },
    ["."]
  );
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
