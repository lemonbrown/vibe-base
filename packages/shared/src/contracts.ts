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

export const DeploymentSchema = z.object({
  id: z.string(),
  appId: z.string(),
  status: DeployStatusSchema,
  imageTag: z.string().nullable(),
  health: HealthSchema,
  error: z.string().nullable(),
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
