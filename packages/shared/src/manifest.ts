import { z } from "zod";

/**
 * vibe.app.yaml — the single source of truth for an app.
 *
 * MVP keeps the surface small but forward-compatible with the full spec:
 * fields the engine does not act on yet (backups, scheduledJobs, actions)
 * are accepted and preserved, but only the marked-active capabilities are
 * provisioned by `vibe apply` / `vibe deploy`.
 */

export const VisibilitySchema = z.enum(["private", "unlisted", "public"]);

export const AccessModeSchema = z.enum(["invite-only", "owner-only", "open"]);

export const RuntimeSchema = z.object({
  type: z.literal("container").default("container"),
  /** Runtime adapter id, e.g. "node-next", "custom-dockerfile". */
  adapter: z.string().default("custom-dockerfile"),
  framework: z.string().optional(),
  language: z.string().optional(),
  packageManager: z.string().optional(),
  /** Port the container listens on. The platform always injects $PORT too. */
  port: z.number().int().positive().default(3000),
  healthPath: z.string().default("/health"),
  buildCommand: z.string().optional(),
  startCommand: z.string().optional(),
  /** Path to a Dockerfile when adapter = custom-dockerfile. */
  dockerfile: z.string().optional(),
});

export const CapabilitiesSchema = z.object({
  auth: z.boolean().default(true),
  database: z.boolean().default(false),
  storage: z.boolean().default(false),
  email: z.boolean().default(false),
  scheduledJobs: z.boolean().default(false),
  actions: z.boolean().default(false),
});

export const DatabaseSchema = z.object({
  engine: z.literal("postgres").default("postgres"),
  /** Command run inside the container after build to apply migrations. */
  migrations: z.string().optional(),
  seed: z.string().optional(),
});

export const StorageSchema = z.object({
  enabled: z.boolean().default(false),
});

export const EmailSchema = z.object({
  enabled: z.boolean().default(false),
  provider: z.string().default("platform"),
});

export const DomainSchema = z.object({
  /** Subdomain under the platform wildcard, e.g. "bible-study-app". */
  subdomain: z.string(),
  customDomains: z.array(z.string()).default([]),
});

export const AccessSchema = z.object({
  mode: AccessModeSchema.default("invite-only"),
  defaultRole: z.string().default("member"),
  ownerRole: z.string().default("owner"),
});

/**
 * Read-models — the app author's declaration of *how the platform/LLM may query
 * this app's live data*. Each is a single read-only SELECT over the app's own
 * database with named, typed parameters. The platform runs them inside a
 * read-only transaction so they can never mutate data. This is what lets an LLM
 * answer questions like "did I buy tomato sauce last month?" without the app
 * exposing its raw schema. Every app with a database should declare these.
 */
export const ReadModelParamSchema = z.object({
  name: z
    .string()
    .regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, "param name must be alphanumeric/underscore"),
  type: z.enum(["string", "number", "boolean", "date"]).default("string"),
  description: z.string().default(""),
  required: z.boolean().default(false),
});
export type ReadModelParam = z.infer<typeof ReadModelParamSchema>;

export const ReadModelSchema = z.object({
  name: z
    .string()
    .regex(/^[a-z0-9][a-z0-9_-]*$/, "read-model name must be lowercase alphanumeric/_/-"),
  description: z.string().default(""),
  /**
   * A single read-only SELECT (or WITH … SELECT) over the app's own database.
   * Use positional placeholders $1, $2, … in the same order as `params`.
   */
  sql: z.string().min(1),
  params: z.array(ReadModelParamSchema).default([]),
});
export type ReadModel = z.infer<typeof ReadModelSchema>;

export const ManifestSchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9-]*$/, "id must be lowercase alphanumeric/dashes"),
  name: z.string().min(1),
  description: z.string().default(""),
  /** SVG string used as the app's icon in the portal. No scripts or external refs. */
  icon: z.string().optional(),
  visibility: VisibilitySchema.default("private"),
  access: AccessSchema.default({}),
  runtime: RuntimeSchema.default({}),
  capabilities: CapabilitiesSchema.default({}),
  database: DatabaseSchema.optional(),
  storage: StorageSchema.optional(),
  email: EmailSchema.optional(),
  domain: DomainSchema,
  roles: z.array(z.string()).default(["owner", "member"]),
  /** How the platform/LLM may query this app's live data (see ReadModelSchema). */
  readModels: z.array(ReadModelSchema).default([]),
});

export type Manifest = z.infer<typeof ManifestSchema>;
export type Runtime = z.infer<typeof RuntimeSchema>;
export type Capabilities = z.infer<typeof CapabilitiesSchema>;
export type AccessMode = z.infer<typeof AccessModeSchema>;

/** Parse + apply defaults. Throws a ZodError with readable issues on failure. */
export function parseManifest(input: unknown): Manifest {
  return ManifestSchema.parse(input);
}

/** Safe parse variant returning the discriminated result. */
export function safeParseManifest(input: unknown) {
  return ManifestSchema.safeParse(input);
}
