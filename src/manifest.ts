import { z } from "zod"
import { isPluginId, sourceIdentityProblem } from "./source.js"

export const PLUGIN_FORMAT_VERSION = 1 as const
/** The plugin API version that `requiresMeva` is checked against. It is not
 * the Meva app version: it changes only when the plugin API breaks. */
export const MEVA_PLUGIN_API_VERSION = "0.6.0"
/** @deprecated Use MEVA_PLUGIN_API_VERSION. */
export const MEVA_PLUGIN_COMPATIBILITY_VERSION = MEVA_PLUGIN_API_VERSION

const semver = z.string().regex(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/)
const semverRangeClause = /^(?:>=|<=|>|<|\^|~)?(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const semverRange = z.string().trim().min(1).max(128).refine((value) => {
  const alternatives = value.split("||").map((alternative) => alternative.trim())
  return alternatives.length > 0 && alternatives.every((alternative) => {
    const clauses = alternative.split(/\s+/).filter(Boolean)
    return clauses.length > 0 && clauses.every((clause) => semverRangeClause.test(clause))
  })
}, "requiresMeva must be a supported semver range")
const identifier = z.string().regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/)
const uuid = z.string().regex(/^(?:[0-9a-f]{4}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i)

const uiNodeSchema: z.ZodType<PluginUiNode> = z.lazy(() =>
  z.union([
    z.object({ type: z.literal("stack"), children: z.array(uiNodeSchema).max(64) }).strict(),
    z.object({ type: z.literal("row"), children: z.array(uiNodeSchema).max(16) }).strict(),
    z.object({ type: z.literal("text"), text: z.string().max(500) }).strict(),
    z.object({ type: z.literal("heading"), text: z.string().max(200) }).strict(),
    z.object({ type: z.literal("separator") }).strict(),
    z.object({
      type: z.literal("slider"), label: z.string().min(1).max(120), bind: identifier,
      min: z.number().finite(), max: z.number().finite(), step: z.number().finite().positive().optional(),
    }).strict().refine((value) => value.min < value.max, "slider min must be less than max"),
    z.object({
      type: z.literal("numberInput"), label: z.string().min(1).max(120), bind: identifier,
      min: z.number().finite().optional(), max: z.number().finite().optional(), step: z.number().finite().positive().optional(),
    }).strict(),
    z.object({
      type: z.literal("select"), label: z.string().min(1).max(120), bind: identifier,
      options: z.array(z.tuple([identifier, z.string().min(1).max(120)])).min(1).max(64),
    }).strict(),
    z.object({ type: z.literal("switch"), label: z.string().min(1).max(120), bind: identifier }).strict(),
    z.object({
      type: z.literal("button"), label: z.string().min(1).max(120), command: identifier,
      role: z.enum(["default", "primary", "destructive"]).optional(),
      userActivation: z.enum(["bluetooth.requestDevice"]).optional(),
    }).strict(),
    z.object({ type: z.literal("status"), bind: identifier.optional() }).strict(),
  ]) as z.ZodType<PluginUiNode>
)

export type PluginUiNode =
  | { type: "stack"; children: PluginUiNode[] }
  | { type: "row"; children: PluginUiNode[] }
  | { type: "text"; text: string }
  | { type: "heading"; text: string }
  | { type: "separator" }
  | { type: "slider"; label: string; bind: string; min: number; max: number; step?: number }
  | { type: "numberInput"; label: string; bind: string; min?: number; max?: number; step?: number }
  | { type: "select"; label: string; bind: string; options: Array<[string, string]> }
  | { type: "switch"; label: string; bind: string }
  | { type: "button"; label: string; command: string; role?: "default" | "primary" | "destructive"; userActivation?: "bluetooth.requestDevice" }
  | { type: "status"; bind?: string }

const actionSchema = z.object({
  slot: z.literal("media.dialog.actions"),
  label: z.string().min(1).max(120),
  icon: z.enum(["printer", "sparkles", "wand", "download", "share"]),
  when: z.object({ mediaType: z.literal("image") }).strict().optional(),
}).strict()

const workspaceSchema = z.object({
  id: identifier,
  action: actionSchema,
  layout: z.object({ type: z.literal("comparison"), secondaryImage: identifier }).strict(),
  sidebar: identifier,
}).strict()

const bluetoothPermissionSchema = z.object({
  filters: z.array(z.object({ namePrefix: z.string().min(1).max(64) }).strict()).min(1).max(8),
  services: z.array(uuid).min(1).max(8),
  characteristics: z.array(uuid).min(1).max(16),
}).strict()

export const pluginManifestSchema = z.object({
  formatVersion: z.literal(PLUGIN_FORMAT_VERSION),
  /** The plugin's repository; its id comes from it (see source.ts). Required
   * to build and install; plugins installed before it existed load without. */
  source: z.string().max(300).optional(),
  id: z.string().max(200).refine((id) => isPluginId(id) && (id.includes("/") || id.includes(".") || id.includes("-") || id.includes("_")), "id must be its source, like github.com/owner/repo"),
  name: z.string().min(1).max(120),
  version: semver,
  requiresMeva: semverRange,
  entrypoint: z.literal("plugin.js"),
  publisher: z.object({ name: z.string().min(1).max(120), url: z.string().url().optional() }).strict().optional(),
  permissions: z.object({
    currentMedia: z.object({ read: z.literal(true) }).strict().optional(),
    bluetooth: bluetoothPermissionSchema.optional(),
  }).strict(),
  contributes: z.object({
    mediaDialogWorkspaces: z.array(workspaceSchema).max(8),
  }).strict(),
  views: z.record(identifier, uiNodeSchema).refine((views) => Object.keys(views).length <= 16),
}).strict().superRefine((manifest, context) => {
  if (manifest.source !== undefined) {
    const problem = sourceIdentityProblem(manifest.id, manifest.source)
    if (problem) context.addIssue({ code: z.ZodIssueCode.custom, path: ["id"], message: problem })
  }
  const workspaces = manifest.contributes.mediaDialogWorkspaces
  if (new Set(workspaces.map((workspace) => workspace.id)).size !== workspaces.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["contributes", "mediaDialogWorkspaces"], message: "workspace IDs must be unique" })
  }
  workspaces.forEach((workspace, index) => {
    if (!manifest.views[workspace.sidebar]) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["contributes", "mediaDialogWorkspaces", index, "sidebar"], message: "workspace sidebar must reference a declared view" })
    }
  })
})

export type PluginManifest = z.infer<typeof pluginManifestSchema>
export type PluginWorkspaceContribution = PluginManifest["contributes"]["mediaDialogWorkspaces"][number]

export const normalizeUuid = (value: string) => {
  const lower = value.toLowerCase()
  return lower.length === 4 ? `0000${lower}-0000-1000-8000-00805f9b34fb` : lower
}

export const validatePluginManifest = (value: unknown) => pluginManifestSchema.parse(value)

/** Throws unless the manifest names its source and its id matches it: needed
 * to build or install any plugin. */
export const assertPluginSource = (manifest: { id: string; source?: string }) => {
  const problem = sourceIdentityProblem(manifest.id, manifest.source)
  if (problem) throw new Error(problem)
}
