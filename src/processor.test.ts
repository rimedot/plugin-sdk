import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import { processorManifestSchema } from "./processor.js"

const wdTagger = JSON.parse(
  readFileSync(path.join(__dirname, "../test/fixtures/wd-tagger.manifest.json"), "utf8")
) as Record<string, unknown>

const labels = {
  formatVersion: 1,
  kind: "processor",
  id: "io.example.labels",
  name: "Labels",
  version: "1.0.0",
  requiresMeva: ">=0.1.0",
  settings: [{ id: "endpoint", label: "Endpoint", type: "endpoint", default: "http://127.0.0.1:9/labels" }],
  processor: {
    media: ["image"],
    protocol: "http-json",
    endpoint: "{endpoint}",
    response: { tags: { path: "/labels" }, data: "/meta" },
    writes: { aiTags: true, data: true },
  },
}

const joyCaption = JSON.parse(
  readFileSync(path.join(__dirname, "../test/fixtures/joycaption.manifest.json"), "utf8")
) as { processor: Record<string, unknown> }

test("the WD tagger manifest validates", () => {
  assert.equal(processorManifestSchema.parse(wdTagger).processor.protocol, "meva-tagger")
})

test("JoyCaption describes on this PC through llama.cpp, on a GPU worker or at an address", () => {
  const parsed = processorManifestSchema.parse(joyCaption)
  assert.deepEqual(parsed.processor.runsOn, ["device", "worker", "address"])
  assert.equal(parsed.processor.writes.descriptions, true)
  const model = parsed.processor.models?.[0]
  assert.equal(model?.recipe, "llava-gguf")
  assert.deepEqual(model?.runtime, { name: "llama.cpp", minVersion: "b11612" })
  assert.deepEqual(model?.files?.map((file) => file.name), ["model.gguf", "mmproj.gguf"])
  const local = (joyCaption.processor.models as Array<Record<string, unknown>>)[0]!
  const withModel = (changes: Record<string, unknown>) => ({ ...joyCaption, processor: { ...joyCaption.processor, models: [{ ...local, ...changes }] } })
  assert.throws(() => processorManifestSchema.parse(withModel({ runtime: undefined })), "llava-gguf needs llama.cpp")
  assert.throws(() => processorManifestSchema.parse(withModel({ files: (local.files as unknown[]).slice(0, 1) })), "the projector is required")
  assert.throws(
    () => processorManifestSchema.parse(withModel({ recipe: "wd", runtime: undefined, files: [{ name: "model.onnx", url: "https://x.example/m", sha256: "0".repeat(64), size: 1 }, { name: "selected_tags.csv", url: "https://x.example/t", sha256: "0".repeat(64), size: 1 }] })),
    "a tagger recipe gives no descriptions"
  )
  assert.throws(
    () => processorManifestSchema.parse({ ...joyCaption, processor: { ...joyCaption.processor, writes: { aiTags: true } } }),
    "llava-gguf needs descriptions or attributes"
  )
  assert.throws(
    () => processorManifestSchema.parse({ ...joyCaption, processor: { ...joyCaption.processor, runsOn: ["worker", "worker"] } }),
    "a place twice"
  )
  const served = { id: "joycaption-beta-one", label: "JoyCaption Beta One" }
  const onWorker = { ...joyCaption, processor: { ...joyCaption.processor, runsOn: ["worker", "address"], models: [served] } }
  assert.equal(processorManifestSchema.parse(onWorker).processor.models?.[0]?.recipe, undefined, "a worker can serve it")
  assert.throws(
    () => processorManifestSchema.parse({ ...onWorker, processor: { ...onWorker.processor, runsOn: ["device", "worker"] } }),
    "this device needs a model with a recipe"
  )
  assert.throws(
    () => processorManifestSchema.parse({ ...onWorker, processor: { ...onWorker.processor, models: [{ ...served, files: [{ name: "model.onnx", url: "https://x.example/m", sha256: "0".repeat(64), size: 1 }] }] } }),
    "files need a recipe"
  )
})

test("processor manifests are checked like the server checks them", () => {
  assert.equal(processorManifestSchema.parse(labels).id, "io.example.labels")
  assert.throws(() => processorManifestSchema.parse({ ...labels, extra: true }))
  assert.throws(() => processorManifestSchema.parse({ ...labels, processor: { ...labels.processor, endpoint: "{missing}" } }))
  assert.throws(() => processorManifestSchema.parse({ ...labels, processor: { ...labels.processor, writes: {} } }))
  assert.throws(() => processorManifestSchema.parse({ ...labels, processor: { ...labels.processor, response: { tags: { path: "labels" } } } }))
  assert.throws(() => processorManifestSchema.parse({
    ...labels,
    processor: { ...labels.processor, protocol: "meva-tagger" },
  }), "meva-tagger has no response mapping")
})

test("a fixed endpoint must be public; local ones need an endpoint setting", () => {
  const fixed = (endpoint: string) => ({ ...labels, settings: [], processor: { ...labels.processor, endpoint } })
  assert.equal(processorManifestSchema.parse(fixed("https://labels.example/labels")).processor.endpoint, "https://labels.example/labels")
  for (const endpoint of ["http://127.0.0.1:9/labels", "http://localhost/x", "http://10.0.0.5/x", "http://100.100.1.1/x", "http://printer.local/x"]) {
    assert.throws(() => processorManifestSchema.parse(fixed(endpoint)), endpoint)
  }
  const textSetting = { ...labels, settings: [{ id: "endpoint", label: "E", type: "text", default: "http://127.0.0.1:9/x" }] }
  assert.throws(() => processorManifestSchema.parse(textSetting))
})
