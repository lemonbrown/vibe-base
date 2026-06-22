import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

export interface Detection {
  adapter: string;
  framework?: string;
  language?: string;
  packageManager: string;
  port: number;
  healthPath: string;
  buildCommand?: string;
  startCommand?: string;
  notes: string[];
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function readJson<T>(p: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(p, "utf8")) as T;
  } catch {
    return null;
  }
}

async function detectPackageManager(cwd: string): Promise<string> {
  if (await exists(join(cwd, "bun.lockb"))) return "bun";
  if (await exists(join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (await exists(join(cwd, "yarn.lock"))) return "yarn";
  return "npm";
}

/** Inspect the project directory and infer a runtime adapter. */
export async function detect(cwd: string): Promise<Detection> {
  const notes: string[] = [];

  if (await exists(join(cwd, "Dockerfile"))) {
    return {
      adapter: "custom-dockerfile",
      packageManager: "n/a",
      port: 8080,
      healthPath: "/health",
      notes: ["Found a Dockerfile — using custom-dockerfile adapter."],
    };
  }

  const pkg = await readJson<{
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    scripts?: Record<string, string>;
  }>(join(cwd, "package.json"));

  const pm = await detectPackageManager(cwd);
  const run = pm === "bun" ? "bun run" : `${pm} run`;

  if (pkg) {
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (deps.next) {
      return {
        adapter: "node-next",
        framework: "nextjs",
        language: "typescript",
        packageManager: pm,
        port: 3000,
        healthPath: "/api/health",
        buildCommand: `${run} build`,
        startCommand: `${run} start`,
        notes: ["Detected Next.js."],
      };
    }
    if (deps.vite) {
      return {
        adapter: "static-site",
        framework: "vite",
        language: "typescript",
        packageManager: pm,
        port: 8080,
        healthPath: "/",
        buildCommand: `${run} build`,
        notes: ["Detected Vite — will serve the built dist/ as a static site."],
      };
    }
    if (deps.express || deps.fastify) {
      return {
        adapter: "node-express",
        framework: deps.fastify ? "fastify" : "express",
        language: "typescript",
        packageManager: pm,
        port: 3000,
        healthPath: "/health",
        buildCommand: pkg.scripts?.build ? `${run} build` : undefined,
        startCommand: pkg.scripts?.start ? `${run} start` : "node index.js",
        notes: [`Detected a Node ${deps.fastify ? "Fastify" : "Express"} server.`],
      };
    }
    return {
      adapter: "node-express",
      language: "javascript",
      packageManager: pm,
      port: 3000,
      healthPath: "/health",
      startCommand: pkg.scripts?.start ? `${run} start` : "node index.js",
      notes: ["Generic Node project — assuming a Node server adapter."],
    };
  }

  if ((await exists(join(cwd, "requirements.txt"))) || (await exists(join(cwd, "pyproject.toml")))) {
    notes.push(
      "Detected Python. The MVP does not yet generate a Python Dockerfile —",
      "add a Dockerfile and set runtime.adapter to custom-dockerfile."
    );
    return {
      adapter: "custom-dockerfile",
      language: "python",
      packageManager: "pip",
      port: 8000,
      healthPath: "/health",
      notes,
    };
  }

  return {
    adapter: "custom-dockerfile",
    packageManager: "n/a",
    port: 8080,
    healthPath: "/health",
    notes: ["Could not detect a stack — defaulting to custom-dockerfile (provide a Dockerfile)."],
  };
}
