import { z } from "zod"
import { isPluginId, sourceIdentityProblem } from "./source.js"

/**
 * Processor plugins: a manifest that tells the Meva server how to send media
 * to a model endpoint and read the answer. No plugin code runs; the server
 * validates the same rules.
 */

const semver = z.string().regex(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/)
const settingId = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/)
const pointer = z.string().refine((value) => value === "" || value.startsWith("/"), "must be a JSON pointer (\"\" or starting with /)")

const settingSchema = z.object({
  id: settingId.refine((id) => !["enabled", "runOnImport", "rerunMode"].includes(id), "this setting id is reserved"),
  label: z.string().min(1).max(120),
  type: z.enum(["text", "number", "boolean", "select", "endpoint", "model"]),
  default: z.unknown(),
  description: z.string().max(500).optional(),
  min: z.number().finite().optional(),
  max: z.number().finite().optional(),
  step: z.number().finite().positive().optional(),
  options: z.array(z.tuple([z.string().min(1), z.string().min(1)])).min(1).max(64).optional(),
}).strict()

// Same files and rules as the server's `check_model`.
const modelFileSchema = z.object({
  name: z.enum(["model.onnx", "selected_tags.csv", "top_tags.txt", "model.gguf", "mmproj.gguf"]),
  url: z.string().url().refine((value) => value.startsWith("https://"), "must be downloaded over HTTPS"),
  sha256: z.string().regex(/^[0-9a-f]{64}$/, "must be a lowercase sha256"),
  size: z.number().int().positive().max(8 * 1024 * 1024 * 1024),
}).strict()

const recipeFiles = {
  wd: ["model.onnx", "selected_tags.csv"],
  joytag: ["model.onnx", "top_tags.txt"],
  "llava-gguf": ["model.gguf", "mmproj.gguf"],
} as const

/** Recipes that describe images (descriptions and attributes), in llama.cpp. */
const describerRecipes: readonly string[] = ["llava-gguf"]

// A model with a recipe runs on this device from its files; one without is
// served by a GPU worker or an address and has no files.
const modelSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/),
  label: z.string().min(1).max(120),
  note: z.string().max(500).optional(),
  revision: z.string().min(1).max(128).optional(),
  recipe: z.enum(["wd", "joytag", "llava-gguf"]).optional(),
  files: z.array(modelFileSchema).max(8).optional(),
  /** The runtime besides ONNX Runtime it needs: llama.cpp for llava-gguf. */
  runtime: z.object({
    name: z.literal("llama.cpp"),
    minVersion: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/).optional(),
  }).strict().optional(),
}).strict().superRefine((model, context) => {
  const files = model.files ?? []
  if (!model.recipe) {
    if (files.length) context.addIssue({ code: z.ZodIssueCode.custom, path: ["files"], message: "files need a recipe" })
    return
  }
  if (!model.revision) context.addIssue({ code: z.ZodIssueCode.custom, path: ["revision"], message: "a model with a recipe needs a revision" })
  if (!files.length) context.addIssue({ code: z.ZodIssueCode.custom, path: ["files"], message: "a model with a recipe needs its files" })
  const names = files.map((file) => file.name)
  if (new Set(names).size !== names.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["files"], message: "a file is listed twice" })
  }
  for (const required of recipeFiles[model.recipe]) {
    if (!names.includes(required)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["files"], message: `the ${model.recipe} recipe needs ${required}` })
    }
  }
  if (model.recipe === "llava-gguf" && !model.runtime) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["runtime"], message: "the llava-gguf recipe needs runtime llama.cpp" })
  }
  if (model.recipe !== "llava-gguf" && model.runtime) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["runtime"], message: `the ${model.recipe} recipe runs in Meva's ONNX Runtime` })
  }
})

const writesSchema = z.object({
  aiTags: z.boolean().optional(),
  classification: z.boolean().optional(),
  data: z.boolean().optional(),
  /** A description of each file, from a describer model (this PC or a GPU worker). */
  descriptions: z.boolean().optional(),
  /** What the describer read from each file (people, clothing, setting, text). */
  attributes: z.boolean().optional(),
}).strict()

/** Where a plugin can run: this device, a paired GPU worker, an address. */
export const processorPlaces = ["device", "worker", "address"] as const

export const processorManifestSchema = z.object({
  formatVersion: z.literal(1),
  /** The plugin's repository; its id comes from it (see source.ts). */
  source: z.string().max(300).optional(),
  kind: z.literal("processor"),
  id: z.string().max(200).refine(isPluginId, "id must be its source, like github.com/owner/repo"),
  name: z.string().min(1).max(80),
  version: semver,
  requiresMeva: z.string().min(1).max(128),
  description: z.string().max(1000).optional(),
  publisher: z.object({ name: z.string().min(1).max(120), url: z.string().url().optional() }).strict().optional(),
  settings: z.array(settingSchema).max(32).default([]),
  processor: z.object({
    media: z.array(z.enum(["image", "video"])).min(1),
    protocol: z.enum(["meva-tagger", "http-json"]),
    endpoint: z.string().min(1),
    model: z.unknown().optional(),
    threshold: z.unknown().optional(),
    videoFrames: z.unknown().optional(),
    request: z.object({
      input: z.enum(["thumbnail", "original"]).optional(),
      field: z.string().min(1).max(64).optional(),
      form: z.record(z.string(), z.unknown()).optional(),
      timeoutSeconds: z.number().int().positive().max(600).optional(),
    }).strict().optional(),
    response: z.object({
      tags: z.object({
        path: pointer,
        name: z.string().optional(),
        score: z.string().optional(),
        minScore: z.unknown().optional(),
        max: z.number().int().positive().optional(),
      }).strict().optional(),
      data: pointer.optional(),
    }).strict().optional(),
    writes: writesSchema,
    models: z.array(modelSchema).max(32).optional(),
    adoptsLegacyTags: z.boolean().optional(),
    runsOn: z.array(z.enum(processorPlaces)).min(1).optional(),
  }).strict(),
}).strict().superRefine((manifest, context) => {
  if (manifest.source !== undefined) {
    const problem = sourceIdentityProblem(manifest.id, manifest.source)
    if (problem) context.addIssue({ code: z.ZodIssueCode.custom, path: ["id"], message: problem })
  }
  const ids = manifest.settings.map((setting) => setting.id)
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["settings"], message: "setting ids must be unique" })
  }
  const templates = (value: unknown, path: (string | number)[]) => {
    if (typeof value !== "string") return
    for (const match of value.matchAll(/\{([^}]*)\}/g)) {
      if (!ids.includes(match[1]!)) {
        context.addIssue({ code: z.ZodIssueCode.custom, path, message: `{${match[1]}} is not a declared setting` })
      }
    }
  }
  const processor = manifest.processor
  const modelIds = (processor.models ?? []).map((model) => model.id)
  if (new Set(modelIds).size !== modelIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["processor", "models"], message: "model ids must be unique" })
  }
  manifest.settings.forEach((setting, index) => {
    if (setting.type !== "model") return
    if (modelIds.length === 0) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["settings", index], message: "a model setting needs processor.models" })
    } else if (typeof setting.default !== "string" || !modelIds.includes(setting.default)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["settings", index, "default"], message: "must be one of processor.models" })
    }
  })
  templates(processor.endpoint, ["processor", "endpoint"])
  // Same rule as the server: one endpoint setting, or a fixed public URL.
  const endpointTemplate = /^\{([^}]*)\}$/.exec(processor.endpoint)
  if (endpointTemplate) {
    const setting = manifest.settings.find((candidate) => candidate.id === endpointTemplate[1])
    if (setting && setting.type !== "endpoint") {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["processor", "endpoint"], message: `{${endpointTemplate[1]}} must be a setting of type endpoint` })
    }
  } else if (processor.endpoint.includes("{")) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["processor", "endpoint"], message: "endpoint must be one endpoint setting or a fixed URL" })
  } else if (processor.endpoint !== "meva:ai-worker" && processor.endpoint !== "device") {
    let host = ""
    try {
      host = new URL(processor.endpoint).hostname.replace(/^\[|\]$/g, "")
    } catch {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["processor", "endpoint"], message: "endpoint must be a URL" })
    }
    if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal") || /^(127\.|10\.|192\.168\.|169\.254\.|0\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|172\.(1[6-9]|2\d|3[01])\.|::1$|::ffff:|f[cd]|fe[89ab])/i.test(host)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["processor", "endpoint"], message: "a fixed endpoint must be a public address; local ones go in an endpoint setting" })
    }
  }
  templates(processor.model, ["processor", "model"])
  templates(processor.threshold, ["processor", "threshold"])
  templates(processor.videoFrames, ["processor", "videoFrames"])
  templates(processor.response?.tags?.minScore, ["processor", "response", "tags", "minScore"])
  for (const [key, value] of Object.entries(processor.request?.form ?? {})) templates(value, ["processor", "request", "form", key])
  const writes = processor.writes
  if (!writes.aiTags && !writes.classification && !writes.data && !writes.descriptions && !writes.attributes) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["processor", "writes"], message: "enable at least one output" })
  }
  if (processor.protocol === "meva-tagger" && (processor.request || processor.response || writes.data)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["processor"], message: "meva-tagger writes tags, classification, descriptions and attributes only, with no request/response mapping" })
  }
  // Same defaults and rules as the server's `ProcessorSpec::places`.
  const local = (processor.models ?? []).some((model) => model.recipe)
  const places = processor.runsOn ?? (processor.protocol === "meva-tagger" ? [...(local ? ["device" as const] : []), "worker" as const, "address" as const] : ["address" as const])
  if (new Set(places).size !== places.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["processor", "runsOn"], message: "a place is listed twice" })
  }
  if (places.includes("device") && !local) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["processor", "runsOn"], message: "device needs a model with a recipe" })
  }
  if (places.includes("worker") && processor.protocol !== "meva-tagger") {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["processor", "runsOn"], message: "worker needs the meva-tagger protocol" })
  }
  if (writes.descriptions || writes.attributes) {
    if (processor.protocol !== "meva-tagger") {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["processor", "writes"], message: "descriptions and attributes need the meva-tagger protocol" })
    }
    if ((processor.models ?? []).some((model) => model.recipe && !describerRecipes.includes(model.recipe))) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["processor", "models"], message: "a plugin that writes descriptions runs describer models (recipe llava-gguf) on this device" })
    }
  } else if ((processor.models ?? []).some((model) => model.recipe && describerRecipes.includes(model.recipe))) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["processor", "writes"], message: "the llava-gguf recipe describes images: it needs writes.descriptions or writes.attributes" })
  }
  if (processor.protocol === "http-json") {
    if (!processor.response) context.addIssue({ code: z.ZodIssueCode.custom, path: ["processor", "response"], message: "http-json needs a response mapping" })
    if (writes.aiTags && !processor.response?.tags) context.addIssue({ code: z.ZodIssueCode.custom, path: ["processor", "response", "tags"], message: "writes.aiTags needs response.tags" })
    if (writes.data && processor.response?.data === undefined) context.addIssue({ code: z.ZodIssueCode.custom, path: ["processor", "response", "data"], message: "writes.data needs response.data" })
    if (writes.classification) context.addIssue({ code: z.ZodIssueCode.custom, path: ["processor", "writes"], message: "http-json cannot write the safety classification" })
  }
})

export type ProcessorManifest = z.infer<typeof processorManifestSchema>

export const isProcessorManifest = (value: unknown): boolean =>
  typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "processor"

export const validateProcessorManifest = (value: unknown) => processorManifestSchema.parse(value)
