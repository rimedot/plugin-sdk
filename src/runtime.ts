import type { PluginManifest } from "./manifest.js"
import { isPluginHostMessage, type PluginHostMessage, type PluginMessage, type PluginRuntimeContext, type PluginTransport } from "./protocol.js"

export type PluginDefinition = {
  id: string
  permissions: PluginManifest["permissions"]
  contributes: PluginManifest["contributes"]
  views: PluginManifest["views"]
  activate?: (context: PluginRuntimeContext) => void | Promise<void>
  commands?: Record<string, (context: PluginRuntimeContext, args?: Record<string, unknown>) => void | Promise<unknown>>
}

const transportFromWindow = (): PluginTransport => {
  const bridge = (globalThis as typeof globalThis & { mevaPlugin?: { send(message: PluginMessage): void; subscribe(listener: (message: PluginHostMessage) => void): () => void } }).mevaPlugin
  if (!bridge) throw new Error("Meva plugin transport is unavailable")
  return bridge
}

export const createPluginContext = (transport: PluginTransport, initialState: Record<string, unknown>): PluginRuntimeContext => {
  const state = new Map(Object.entries(initialState))
  const stateListeners = new Set<(patch: Record<string, unknown>) => void>()
  const notificationListeners = new Map<string, Set<(bytes: ArrayBuffer) => void>>()
  let sequence = 0
  const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  transport.subscribe((message) => {
    if (!isPluginHostMessage(message)) return
    if (message.type === "state.changed") {
      for (const [key, value] of Object.entries(message.patch)) state.set(key, value)
      for (const listener of stateListeners) listener(message.patch)
    }
    if (message.type === "capability.result") {
      const request = pending.get(message.requestId)
      if (!request) return
      pending.delete(message.requestId)
      if (message.ok) request.resolve(message.value)
      else request.reject(new Error(message.error))
    }
    if (message.type === "bluetooth.notification") {
      for (const listener of notificationListeners.get(message.grantId) ?? []) listener(message.bytes)
    }
    if (message.type === "lifecycle.revoked") {
      const error = new Error(`Plugin capability revoked: ${message.reason}`)
      for (const request of pending.values()) request.reject(error)
      pending.clear()
      notificationListeners.clear()
    }
  })
  const request = <T>(capability: Extract<PluginMessage, { type: "capability.request" }>["capability"], args?: unknown) => {
    const requestId = `${Date.now().toString(36)}-${(++sequence).toString(36)}`
    return new Promise<T>((resolve, reject) => {
      pending.set(requestId, { resolve: resolve as (value: unknown) => void, reject })
      transport.send({ type: "capability.request", requestId, capability, args })
    })
  }
  return {
    state: {
      get: <T>(key: string) => state.get(key) as T | undefined,
      set: (key, value) => { state.set(key, value); transport.send({ type: "state.patch", patch: { [key]: value } }) },
      patch: (values) => { for (const [key, value] of Object.entries(values)) state.set(key, value); transport.send({ type: "state.patch", patch: values }) },
      subscribe: (listener) => { stateListeners.add(listener); return () => stateListeners.delete(listener) },
    },
    media: { readCurrent: () => request("media.readCurrent") },
    bluetooth: {
      requestDevice: () => request("bluetooth.requestDevice"),
      connect: (grantId) => request("bluetooth.connect", { grantId }),
      write: (grantId, service, characteristic, bytes) => request("bluetooth.write", { grantId, service, characteristic, bytes }),
      subscribe: (grantId, service, characteristic) => request("bluetooth.subscribe", { grantId, service, characteristic }),
      onNotification: (grantId, listener) => {
        const listeners = notificationListeners.get(grantId) ?? new Set<(bytes: ArrayBuffer) => void>()
        listeners.add(listener)
        notificationListeners.set(grantId, listeners)
        return () => {
          listeners.delete(listener)
          if (listeners.size === 0) notificationListeners.delete(grantId)
        }
      },
      disconnect: (grantId) => request("bluetooth.disconnect", { grantId }),
    },
    preview: (binding, bytes, width, height) => transport.send({ type: "preview.updated", binding, mime: "image/png", bytes, width, height }),
    log: (level, message, details) => transport.send({ type: "plugin.log", level, message, ...(details ? { details } : {}) }),
  }
}

export const startPlugin = async (plugin: PluginDefinition, initialState: Record<string, unknown>) => {
  const transport = transportFromWindow()
  const context = createPluginContext(transport, initialState)
  transport.subscribe((message) => {
    if (!isPluginHostMessage(message)) return
    if (message.type !== "command.invoke") return
    const handler = plugin.commands?.[message.command]
    if (!handler) {
      transport.send({ type: "command.result", requestId: message.requestId, ok: false, error: `Unknown plugin command: ${message.command}` })
      return
    }
    void Promise.resolve(handler(context, message.args)).then(
      (value) => transport.send({ type: "command.result", requestId: message.requestId, ok: true, value }),
      (error) => transport.send({ type: "command.result", requestId: message.requestId, ok: false, error: error instanceof Error ? error.message : String(error) })
    )
  })
  try {
    await plugin.activate?.(context)
  } catch (error) {
    transport.send({ type: "plugin.error", error: error instanceof Error ? error.message : String(error) })
    return context
  }
  transport.send({ type: "plugin.ready" })
  return context
}
