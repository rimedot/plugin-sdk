import test from "node:test"
import assert from "node:assert/strict"
import { assertPluginSource, pluginManifestSchema } from "./manifest.js"
import { processorManifestSchema } from "./processor.js"
import { runnerManifestSchema } from "./runner.js"
import { isPluginId, MEVA_SOURCE, parseSource, pluginIdFromSource, sourceIdentityProblem } from "./source.js"

test("a source gives the plugin's id", () => {
  assert.equal(pluginIdFromSource("https://github.com/Some-One/My.Plugin.git"), "github.com/some-one/my.plugin")
  assert.equal(pluginIdFromSource("https://codeberg.org/owner/repo/"), "codeberg.org/owner/repo")
  assert.throws(() => parseSource("http://github.com/a/b"), /https/)
  assert.throws(() => parseSource("https://github.com/a"), /repository itself/)
  assert.throws(() => parseSource("https://127.0.0.1/a/b"), /public host/)
  assert.ok(isPluginId("github.com/a/b") && isPluginId("io.meva.colors"))
  assert.ok(!isPluginId("github.com/A/b"))
})

test("an id must match its source; Meva's own plugins keep reverse-DNS ids", () => {
  assert.equal(sourceIdentityProblem("github.com/a/b", "https://github.com/a/b"), null)
  assert.match(sourceIdentityProblem("github.com/a/c", "https://github.com/a/b") ?? "", /makes it github.com\/a\/b/)
  assert.equal(sourceIdentityProblem("io.meva.colors", MEVA_SOURCE), null)
  assert.notEqual(sourceIdentityProblem("io.example.x", "https://github.com/a/b"), null)
  assert.match(sourceIdentityProblem("github.com/a/b", undefined) ?? "", /needs a source/)
})

const ui = {
  formatVersion: 1,
  source: "https://github.com/a/printer",
  id: "github.com/a/printer",
  name: "Printer",
  version: "1.0.0",
  requiresMeva: ">=0.5.0",
  entrypoint: "plugin.js",
  permissions: {},
  contributes: { mediaDialogWorkspaces: [] },
  views: {},
}

test("UI and processor manifests check their source", () => {
  assert.doesNotThrow(() => assertPluginSource(pluginManifestSchema.parse(ui)))
  assert.throws(() => pluginManifestSchema.parse({ ...ui, id: "github.com/a/other" }))
  const legacy: Record<string, unknown> = { ...ui, id: "io.example.printer" }
  delete legacy.source
  // Installed before sources: loads, but cannot be built or installed again.
  const parsed = pluginManifestSchema.parse(legacy)
  assert.throws(() => assertPluginSource(parsed), /needs a source/)
  assert.throws(() => processorManifestSchema.parse({
    formatVersion: 1, source: "https://github.com/a/b", kind: "processor", id: "github.com/a/c", name: "x", version: "1.0.0", requiresMeva: ">=0.1.0",
    processor: { media: ["image"], protocol: "http-json", endpoint: "https://x.example/a", response: { tags: { path: "" } }, writes: { aiTags: true } },
  }))
})

test("runner manifests list a build per platform with its sha256", () => {
  const runner = {
    formatVersion: 1,
    source: "https://github.com/a/runner",
    kind: "runner",
    id: "github.com/a/runner",
    name: "Runner",
    version: "1.0.0",
    requiresMeva: ">=0.5.0",
    runner: {
      protocol: "meva-tag.v1",
      gpu: true,
      network: ["huggingface.co"],
      platforms: [{ os: "linux", arch: "x86_64", asset: "runner-linux-x86_64.tar.gz", sha256: "a".repeat(64), size: 10 }],
    },
  }
  assert.doesNotThrow(() => runnerManifestSchema.parse(runner))
  assert.throws(() => runnerManifestSchema.parse({ ...runner, runner: { ...runner.runner, network: ["127.0.0.1"] } }))
  assert.throws(() => runnerManifestSchema.parse({ ...runner, runner: { ...runner.runner, platforms: [...runner.runner.platforms, ...runner.runner.platforms] } }), /twice/)
  assert.throws(() => runnerManifestSchema.parse({ ...runner, runner: { ...runner.runner, protocol: "other" } }))
  assert.throws(() => runnerManifestSchema.parse({ ...runner, runner: { ...runner.runner, platforms: [{ ...runner.runner.platforms[0], os: "beos" }] } }))
})
