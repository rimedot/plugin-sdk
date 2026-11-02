import test from "node:test"
import assert from "node:assert/strict"
import { createPluginContext } from "./runtime.js"
import type { PluginHostMessage, PluginMessage, PluginTransport } from "./protocol.js"

const makeTransport = () => {
  const sent: PluginMessage[] = []
  const listeners = new Set<(message: PluginHostMessage) => void>()
  const transport: PluginTransport = {
    send: (message) => sent.push(message),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  return {
    transport,
    sent,
    dispatch: (message: PluginHostMessage) => { for (const listener of listeners) listener(message) },
  }
}

test("runtime context transports state and capability requests", async () => {
  const fake = makeTransport()
  const context = createPluginContext(fake.transport, { contrast: 0 })
  context.state.set("contrast", 20)
  assert.deepEqual(fake.sent[0], { type: "state.patch", patch: { contrast: 20 } })
  const pending = context.media.readCurrent()
  const request = fake.sent[1]
  assert.equal(request?.type, "capability.request")
  if (request?.type !== "capability.request") throw new Error("missing capability request")
  fake.dispatch({ type: "capability.result", requestId: request.requestId, ok: true, value: { grantId: "media:opaque" } })
  assert.deepEqual(await pending, { grantId: "media:opaque" })
})

test("lifecycle revocation rejects pending capabilities and removes notifications", async () => {
  const fake = makeTransport()
  const context = createPluginContext(fake.transport, {})
  let notifications = 0
  context.bluetooth.onNotification("grant", () => { notifications += 1 })
  const pending = context.bluetooth.connect("grant")
  fake.dispatch({ type: "lifecycle.revoked", reason: "media-closed" })
  await assert.rejects(pending, /media-closed/)
  fake.dispatch({ type: "bluetooth.notification", grantId: "grant", bytes: new ArrayBuffer(1) })
  assert.equal(notifications, 0)
})
