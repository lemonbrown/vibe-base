import { z } from "zod";
import { ManifestSchema } from "./manifest.js";

/** Platform-level roles. App-specific roles are declared in the manifest. */
export const PlatformRoleSchema = z.enum(["owner", "leader", "member"]);
export type PlatformRole = z.infer<typeof PlatformRoleSchema>;

export const DeployStatusSchema = z.enum([
  "queued",
  "building",
  "migrating",
  "starting",
  "health_check",
  "live",
  "failed",
]);
export type DeployStatus = z.infer<typeof DeployStatusSchema>;

export const HealthSchema = z.enum(["healthy", "unhealthy", "unknown"]);
export type Health = z.infer<typeof HealthSchema>;

/* ----------------------------- API: apps ------------------------------ */

export const RegisterAppRequestSchema = z.object({
  manifest: ManifestSchema,
});
export type RegisterAppRequest = z.infer<typeof RegisterAppRequestSchema>;

export const AppSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  visibility: z.string(),
  status: z.string(),
  url: z.string().nullable(),
  health: HealthSchema,
  currentDeploymentId: z.string().nullable(),
  lastDeployedAt: z.string().nullable(),
});
export type AppSummary = z.infer<typeof AppSummarySchema>;

/* --------------------------- API: deploy ------------------------------ */

export const DeploySourceSchema = z.enum(["context", "image"]);
export type DeploySource = z.infer<typeof DeploySourceSchema>;

export const DeploymentSchema = z.object({
  id: z.string(),
  appId: z.string(),
  status: DeployStatusSchema,
  imageTag: z.string().nullable(),
  health: HealthSchema,
  error: z.string().nullable(),
  source: DeploySourceSchema,
  gitSha: z.string().nullable(),
  gitRef: z.string().nullable(),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
});
export type Deployment = z.infer<typeof DeploymentSchema>;

/* --------------------------- API: status ------------------------------ */

export const AppStatusSchema = z.object({
  app: AppSummarySchema,
  manifestSummary: z.object({
    runtimeAdapter: z.string(),
    port: z.number(),
    healthPath: z.string(),
    capabilities: z.record(z.boolean()),
  }),
  database: z.object({
    enabled: z.boolean(),
    provisioned: z.boolean(),
  }),
  storage: z.object({
    enabled: z.boolean(),
    provisioned: z.boolean(),
  }),
  members: z.number(),
  recentDeployments: z.array(DeploymentSchema),
});
export type AppStatus = z.infer<typeof AppStatusSchema>;

/* -------------------------- API: members ------------------------------ */

export const InviteRequestSchema = z.object({
  email: z.string().email(),
  role: PlatformRoleSchema.default("member"),
});
export type InviteRequest = z.infer<typeof InviteRequestSchema>;

export const MemberSchema = z.object({
  email: z.string(),
  role: PlatformRoleSchema,
  status: z.enum(["invited", "active", "revoked"]),
  invitedAt: z.string(),
});
export type Member = z.infer<typeof MemberSchema>;

/* ----------------------- Secret presence map -------------------------- */
/** Per spec §23.1: the LLM sees which secrets exist, never their values. */
export const SecretPresenceSchema = z.record(
  z.object({
    present: z.boolean(),
    type: z.string().optional(),
    required: z.boolean().optional(),
  })
);
export type SecretPresence = z.infer<typeof SecretPresenceSchema>;

/* ---------------------- API: platform query layer --------------------- */
/**
 * The read-only surface an LLM uses to reason about the live platform. Every
 * response here is deliberately projected to be secret-free — it carries the
 * *presence* and *shape* of things (which apps, which secrets exist, which
 * read-models), never credential values. See spec §23.1.
 */

/** One app's line in the platform overview. */
export interface PlatformAppLine {
  id: string;
  name: string;
  status: string;
  health: Health;
  url: string | null;
  visibility: string;
  lastDeployedAt: string | null;
  members: number;
  readModels: number;
  database: boolean;
  storage: boolean;
}

export interface PlatformOverview {
  generatedAt: string;
  totals: { apps: number; live: number; unhealthy: number };
  apps: PlatformAppLine[];
}

/** Describes a queryable read-model to the LLM (no SQL leaked). */
export interface ReadModelInfo {
  name: string;
  description: string;
  params: Array<{
    name: string;
    type: string;
    description: string;
    required: boolean;
  }>;
}

export interface PlatformAppDetail {
  app: AppSummary;
  description: string;
  manifestSummary: {
    runtimeAdapter: string;
    port: number;
    healthPath: string;
    capabilities: Record<string, boolean>;
  };
  access: { mode: string; defaultRole: string; visibility: string; roles: string[] };
  database: { enabled: boolean; provisioned: boolean };
  storage: { enabled: boolean; provisioned: boolean };
  members: Array<{ email: string; role: string; status: string }>;
  recentDeployments: Deployment[];
  repo: { repoFullName: string; defaultBranch: string; htmlUrl: string | null } | null;
  /** Which secrets exist for this app — names only, never values. */
  secrets: SecretPresence;
  readModels: ReadModelInfo[];
}

/** The result of running a read-model. */
export interface ReadModelResult {
  app: string;
  model: string;
  columns: string[];
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  /** True when the result was capped at the row limit. */
  truncated: boolean;
}
