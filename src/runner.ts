import { z } from "zod"
import { isSourceId, sourceIdentityProblem } from "./source.js"

/**
 * Runner plugins: a native program Meva's server starts in its own process
 * and talks to over the runner protocol (`meva-tag.v1`). The `.mevax` holds
 * only this manifest; each platform's build is a separate release file whose
 * sha256 the manifest lists. Same rules as the server's
 * `validate_runner_manifest`.
 */

export const RUNNER_PROTOCOL = "meva-tag.v1"
export const runnerPlatformOs = ["linux", "macos", "windows"] as const
export const runnerPlatformArch = ["x86_64", "aarch64"] as const

const semver = z.string().regex(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/)
const host = z.string().max(253).refine(
  (value) => value.includes(".") && !/^[\d.]+$/.test(value) && !value.endsWith(".local") && !value.endsWith(".internal") && value.split(".").every((label) => /^[a-z0-9-]{1,63}$/.test(label)),
  "must be a public host name like huggingface.co"
)

const platformSchema = z.object({
  os: z.enum(runnerPlatformOs),
  arch: z.enum(runnerPlatformArch),
  asset: z.string().regex(/^[A-Za-z0-9._+-]{1,128}$/).refine((value) => value !== "." && value !== "..", "must be a release file name"),
  sha256: z.string().regex(/^[0-9a-f]{64}$/, "must be a lowercase sha256"),
  size: z.number().int().positive().max(2 * 1024 * 1024 * 1024),
}).strict()

export const runnerManifestSchema = z.object({
  formatVersion: z.literal(1),
  source: z.string().max(300),
  kind: z.literal("runner"),
  id: z.string().max(200).refine(isSourceId, "id must be its source, like github.com/owner/repo"),
  name: z.string().min(1).max(80),
  version: semver,
  requiresMeva: z.string().min(1).max(128),
  description: z.string().max(1000).optional(),
  publisher: z.object({ name: z.string().min(1).max(120), url: z.string().url().optional() }).strict().optional(),
  runner: z.object({
    protocol: z.literal(RUNNER_PROTOCOL),
    /** It uses the GPU. */
    gpu: z.boolean().optional(),
    /** Hosts it connects to, for example to download models. */
    network: z.array(host).max(16).optional(),
    platforms: z.array(platformSchema).min(1).max(16),
  }).strict(),
}).strict().superRefine((manifest, context) => {
  const problem = sourceIdentityProblem(manifest.id, manifest.source)
  if (problem) context.addIssue({ code: z.ZodIssueCode.custom, path: ["id"], message: problem })
  const seen = new Set<string>()
  manifest.runner.platforms.forEach((build, index) => {
    const key = `${build.os} ${build.arch}`
    if (seen.has(key)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["runner", "platforms", index], message: `${key} is listed twice` })
    seen.add(key)
  })
})

export type RunnerManifest = z.infer<typeof runnerManifestSchema>

export const isRunnerManifest = (value: unknown): boolean =>
  typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "runner"

export const validateRunnerManifest = (value: unknown) => runnerManifestSchema.parse(value)
