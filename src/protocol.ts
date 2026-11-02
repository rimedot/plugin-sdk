import { pluginManifestSchema, type PluginUiNode } from "./manifest.js"

export type PluginRuntimeInit = {
  type: "host.init"
  protocolVersion: 1
  pluginId: string
  manifest: import("./manifest.js").PluginManifest
  initialState: Record<string, unknown>
}

export type PluginHostMessage =
  | PluginRuntimeInit
  | { type: "command.invoke"; requestId: string; command: string; args?: Record<string, unknown>; userActivation?: "bluetooth.requestDevice" }
  | { type: "state.changed"; patch: Record<string, unknown> }
  | { type: "bluetooth.notification"; grantId: string; bytes: ArrayBuffer }
  | { type: "capability.result"; requestId: string; ok: true; value: unknown }
  | { type: "capability.result"; requestId: string; ok: false; error: string }
  | { type: "lifecycle.revoked"; reason: "media-closed" | "media-changed" | "disabled" | "crashed" }

export type PluginMessage =
  | { type: "plugin.ready" }
  | { type: "plugin.error"; error: string }
  | { type: "plugin.log"; level: "debug" | "info" | "warn" | "error"; message: string; details?: Record<string, unknown> }
  | { type: "state.patch"; patch: Record<string, unknown> }
  | { type: "preview.updated"; binding: string; mime: "image/png"; bytes: ArrayBuffer; width: number; height: number }
  | { type: "command.result"; requestId: string; ok: true; value?: unknown }
  | { type: "command.result"; requestId: string; ok: false; error: string }
  | { type: "capability.request"; requestId: string; capability: "media.readCurrent" | "bluetooth.requestDevice" | "bluetooth.connect" | "bluetooth.write" | "bluetooth.subscribe" | "bluetooth.disconnect"; args?: unknown }

export type PluginTransport = {
  send(message: PluginMessage): void
  subscribe(listener: (message: PluginHostMessage) => void): () => void
}

export type PluginRuntimeContext = {
  state: {
    get<T = unknown>(key: string): T | undefined
    set(key: string, value: unknown): void
    patch(values: Record<string, unknown>): void
    subscribe(listener: (patch: Record<string, unknown>) => void): () => void
  }
  media: { readCurrent(): Promise<{ grantId: string; mime: string; width: number; height: number; bytes: ArrayBuffer }> }
  bluetooth: {
    requestDevice(): Promise<{ grantId: string; name: string }>
    connect(grantId: string): Promise<void>
    write(grantId: string, service: string, characteristic: string, bytes: ArrayBuffer): Promise<void>
    subscribe(grantId: string, service: string, characteristic: string): Promise<void>
    onNotification(grantId: string, listener: (bytes: ArrayBuffer) => void): () => void
    disconnect(grantId: string): Promise<void>
  }
  preview(binding: string, bytes: ArrayBuffer, width: number, height: number): void
  log(level: "debug" | "info" | "warn" | "error", message: string, details?: Record<string, unknown>): void
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value))

const isString = (value: unknown): value is string => typeof value === "string"
const isArrayBuffer = (value: unknown): value is ArrayBuffer => value instanceof ArrayBuffer
const isFinitePositiveInteger = (value: unknown) =>
  typeof value === "number" && Number.isInteger(value) && value > 0

const isStateValue = (value: unknown, depth = 0): boolean => {
  if (value === null || typeof value === "boolean" || typeof value === "undefined") return true
  if (typeof value === "string") return value.length <= 8192
  if (typeof value === "number") return Number.isFinite(value)
  if (depth >= 8 || value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return false
  if (Array.isArray(value)) return value.length <= 128 && value.every((item) => isStateValue(item, depth + 1))
  if (!isRecord(value)) return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  const keys = Object.keys(value)
  return keys.length <= 128 && keys.every((key) => key.length <= 128 && isStateValue(value[key], depth + 1))
}

export const isStatePatch = (value: unknown): value is Record<string, unknown> =>
  isRecord(value) && isStateValue(value)

type PluginCapability = Extract<PluginMessage, { type: "capability.request" }>["capability"]

const hostCapabilities = new Set<PluginCapability>([
  "media.readCurrent",
  "bluetooth.requestDevice",
  "bluetooth.connect",
  "bluetooth.write",
  "bluetooth.subscribe",
  "bluetooth.disconnect",
])

export const isPluginHostMessage = (value: unknown): value is PluginHostMessage => {
  if (!isRecord(value) || !isString(value.type)) return false
  switch (value.type) {
    case "host.init":
      return value.protocolVersion === 1 && isString(value.pluginId) &&
        pluginManifestSchema.safeParse(value.manifest).success &&
        isRecord(value.initialState)
    case "command.invoke":
      return isString(value.requestId) && isString(value.command) &&
        (value.args === undefined || isRecord(value.args)) &&
        (value.userActivation === undefined || value.userActivation === "bluetooth.requestDevice")
    case "state.changed":
      return isStatePatch(value.patch)
    case "bluetooth.notification":
      return isString(value.grantId) && isArrayBuffer(value.bytes)
    case "capability.result":
      return isString(value.requestId) &&
        (value.ok === true || (value.ok === false && isString(value.error)))
    case "lifecycle.revoked":
      return value.reason === "media-closed" || value.reason === "media-changed" ||
        value.reason === "disabled" || value.reason === "crashed"
    default:
      return false
  }
}

export const isPluginMessage = (value: unknown): value is PluginMessage => {
  if (!isRecord(value) || !isString(value.type)) return false
  switch (value.type) {
    case "plugin.ready":
      return true
    case "plugin.error":
      return isString(value.error) && value.error.length <= 2048
    case "plugin.log":
      return (value.level === "debug" || value.level === "info" || value.level === "warn" || value.level === "error") &&
        isString(value.message) && value.message.length <= 512 &&
        (value.details === undefined || isStatePatch(value.details))
    case "state.patch":
      return isStatePatch(value.patch)
    case "preview.updated":
      return isString(value.binding) && value.mime === "image/png" &&
        isArrayBuffer(value.bytes) && isFinitePositiveInteger(value.width) &&
        isFinitePositiveInteger(value.height)
    case "command.result":
      return isString(value.requestId) &&
        (value.ok === true || (value.ok === false && isString(value.error)))
    case "capability.request":
      return isString(value.requestId) && isString(value.capability) &&
        hostCapabilities.has(value.capability as PluginCapability)
    default:
      return false
  }
}

export type ValidatedPluginView = { id: string; root: PluginUiNode }
