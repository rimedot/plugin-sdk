export * from "./manifest.js"
export * from "./processor.js"
export * from "./protocol.js"
export * from "./runner.js"
export * from "./source.js"
export * from "./source-plugin.js"
export * from "./runtime.js"
export * from "./zip.js"

import type { PluginDefinition } from "./runtime.js"

export const definePlugin = (plugin: PluginDefinition) => Object.freeze(plugin)

export const ui = {
  stack: (children: import("./manifest.js").PluginUiNode[]) => ({ type: "stack", children } as const),
  row: (children: import("./manifest.js").PluginUiNode[]) => ({ type: "row", children } as const),
  text: (text: string) => ({ type: "text", text } as const),
  heading: (text: string) => ({ type: "heading", text } as const),
  separator: () => ({ type: "separator" } as const),
  slider: (value: Omit<Extract<import("./manifest.js").PluginUiNode, { type: "slider" }>, "type">) => ({ type: "slider", ...value } as const),
  numberInput: (value: Omit<Extract<import("./manifest.js").PluginUiNode, { type: "numberInput" }>, "type">) => ({ type: "numberInput", ...value } as const),
  select: (value: Omit<Extract<import("./manifest.js").PluginUiNode, { type: "select" }>, "type">) => ({ type: "select", ...value } as const),
  switch: (value: Omit<Extract<import("./manifest.js").PluginUiNode, { type: "switch" }>, "type">) => ({ type: "switch", ...value } as const),
  button: (value: Omit<Extract<import("./manifest.js").PluginUiNode, { type: "button" }>, "type">) => ({ type: "button", ...value } as const),
  status: (bind?: string) => ({ type: "status", ...(bind ? { bind } : {}) } as const),
}
