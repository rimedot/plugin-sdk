import test from "node:test"
import assert from "node:assert/strict"
import { isPluginHostMessage, isPluginMessage, isStatePatch } from "./protocol.js"

const manifest = {
  formatVersion: 1,
  id: "io.example.test",
  name: "Test",
  version: "1.0.0",
  requiresMeva: ">=0.1.0",
  entrypoint: "plugin.js",
  permissions: {},
  contributes: { mediaDialogWorkspaces: [] },
  views: {},
} as const

test("protocol validators reject unknown and malformed messages", () => {
  assert.equal(isPluginHostMessage({ type: "host.unknown" }), false)
  assert.equal(isPluginMessage({ type: "capability.request", requestId: "1", capability: "filesystem.read" }), false)
  assert.equal(isPluginMessage({ type: "plugin.error", error: "x" }), true)
  assert.equal(isPluginMessage({ type: "plugin.error", error: "x".repeat(2049) }), false)
  assert.equal(isPluginMessage({ type: "plugin.log", level: "info", message: "connected", details: { bytes: 3 } }), true)
  assert.equal(isPluginMessage({ type: "plugin.log", level: "info", message: "x", details: { bytes: new ArrayBuffer(1) } }), false)
  assert.equal(isPluginMessage({ type: "preview.updated", binding: "preview", mime: "image/png", bytes: new ArrayBuffer(1), width: 0, height: 1 }), false)
  assert.equal(isStatePatch({ value: new Map() }), false)
  assert.equal(isStatePatch({ value: new ArrayBuffer(1) }), false)
})

test("protocol validators accept bounded structured messages", () => {
  assert.equal(isPluginHostMessage({ type: "host.init", protocolVersion: 1, pluginId: manifest.id, manifest, initialState: {} }), true)
  assert.equal(isPluginHostMessage({ type: "command.invoke", requestId: "1", command: "print", args: {} }), true)
  assert.equal(isPluginMessage({ type: "capability.request", requestId: "1", capability: "media.readCurrent" }), true)
  assert.equal(isPluginMessage({ type: "preview.updated", binding: "preview", mime: "image/png", bytes: new ArrayBuffer(1), width: 1, height: 1 }), true)
})
