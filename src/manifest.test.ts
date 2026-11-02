import test from "node:test"
import assert from "node:assert/strict"
import { pluginManifestSchema } from "./manifest.js"
import { createArchive, validateArchiveEntries } from "./zip.js"

const manifest = {
  formatVersion: 1,
  id: "io.example.test",
  name: "Example",
  version: "1.0.0",
  requiresMeva: ">=0.1.0 <0.2.0",
  entrypoint: "plugin.js",
  permissions: { currentMedia: { read: true } },
  contributes: { mediaDialogWorkspaces: [] },
  views: {},
}

test("manifest accepts bounded compatibility ranges and rejects undeclared fields", () => {
  assert.equal(pluginManifestSchema.parse(manifest).requiresMeva, ">=0.1.0 <0.2.0")
  assert.throws(() => pluginManifestSchema.parse({ ...manifest, requiresMeva: "latest" }))
  assert.throws(() => pluginManifestSchema.parse({ ...manifest, unexpected: true }))
  assert.throws(() => pluginManifestSchema.parse({ ...manifest, permissions: { filesystem: { read: true } } }))
  assert.throws(() => pluginManifestSchema.parse({ ...manifest, permissions: { bluetooth: { filters: [{ namePrefix: "GT01" }], services: ["not-a-uuid"], characteristics: ["AE01"] } } }))
  assert.throws(() => pluginManifestSchema.parse({
    ...manifest,
    contributes: {
      mediaDialogWorkspaces: [{
        id: "workspace",
        action: { slot: "media.dialog.actions", label: "Open", icon: "printer" },
        layout: { type: "comparison", secondaryImage: "preview" },
        sidebar: "missing",
      }],
    },
  }))
})

test("manifest rejects unsupported UI primitives and extension slots", () => {
  assert.throws(() => pluginManifestSchema.parse({
    ...manifest,
    contributes: {
      mediaDialogWorkspaces: [{
        id: "workspace",
        action: { slot: "page.anywhere", label: "Open", icon: "printer" },
        layout: { type: "comparison", secondaryImage: "preview" },
        sidebar: "settings",
      }],
    },
    views: { settings: { type: "html", html: "<p>no</p>" } },
  }))
})

test("archive validation rejects unsafe names and preserves allowed entries", () => {
  const archive = createArchive({ "manifest.json": "{}", "plugin.js": "" })
  assert.deepEqual(Object.keys(validateArchiveEntries(archive)).sort(), ["manifest.json", "plugin.js"])
  assert.throws(() => createArchive({ "../plugin.js": "" }))
  assert.throws(() => createArchive({ "/plugin.js": "" }))
  assert.throws(() => createArchive({ "C:/plugin.js": "" }))
})
