#!/usr/bin/env node
import { build } from "esbuild"
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { createArchive, validateArchiveEntries } from "./zip.js"
import { assertPluginSource, pluginManifestSchema } from "./manifest.js"
import { isProcessorManifest, processorManifestSchema } from "./processor.js"
import { isRunnerManifest, runnerManifestSchema } from "./runner.js"
import { isSourceManifest, SOURCE_BUNDLE_GLOBAL, sourceManifestSchema } from "./source-plugin.js"

const usage = () => {
  console.error("Usage: meva-plugin build --entry plugin.ts --manifest manifest.json --out plugin.mevax")
  console.error("       meva-plugin build --manifest manifest.json --out plugin.mevax [--readme README.md]  (processor and runner plugins)")
  console.error("       meva-plugin build --entry source.ts --manifest manifest.json --out plugin.mevax [--readme README.md]  (source plugins)")
  console.error("       meva-plugin validate plugin.mevax")
  process.exitCode = 2
}

const option = (args: string[], name: string) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

const PROCESSOR_ENTRIES = ["manifest.json", "plugin.js", "icon.svg", "LICENSE", "README.md"]
const RUNNER_ENTRIES = ["manifest.json", "icon.svg", "LICENSE", "README.md"]
const SOURCE_ENTRIES = ["manifest.json", "plugin.js", "icon.svg", "LICENSE", "README.md"]

const validate = (bytes: Uint8Array): { id: string; version: string; requiresMeva: string } => {
  const entries = validateArchiveEntries(bytes)
  const names = new Set(Object.keys(entries))
  if (!names.has("manifest.json")) throw new Error("Missing manifest.json")
  const raw = JSON.parse(new TextDecoder().decode(entries["manifest.json"]!)) as unknown
  if (isProcessorManifest(raw)) {
    for (const name of names) if (!PROCESSOR_ENTRIES.includes(name)) throw new Error(`Unexpected archive entry: ${name}`)
    const processor = processorManifestSchema.parse(raw)
    assertPluginSource(processor)
    return processor
  }
  if (isSourceManifest(raw)) {
    for (const name of names) if (!SOURCE_ENTRIES.includes(name)) throw new Error(`Unexpected archive entry: ${name}`)
    if (!names.has("plugin.js")) throw new Error("Missing plugin.js")
    return sourceManifestSchema.parse(raw)
  }
  if (isRunnerManifest(raw)) {
    // The program is a separate release file per platform, never in the archive.
    for (const name of names) if (!RUNNER_ENTRIES.includes(name)) throw new Error(`Unexpected archive entry: ${name}`)
    return runnerManifestSchema.parse(raw)
  }
  for (const required of ["manifest.json", "plugin.js"]) if (!names.has(required)) throw new Error(`Missing ${required}`)
  const manifest = pluginManifestSchema.parse(JSON.parse(new TextDecoder().decode(entries["manifest.json"]!)))
  assertPluginSource(manifest)
  if (manifest.entrypoint !== "plugin.js") throw new Error("Entrypoint must be plugin.js")
  for (const name of names) if (!["manifest.json", "plugin.js", "icon.svg", "LICENSE"].includes(name)) throw new Error(`Unexpected archive entry: ${name}`)
  return manifest
}

const main = async () => {
  const [command, ...args] = process.argv.slice(2)
  if (command === "validate") {
    const input = args[0]
    if (!input) return usage()
    const manifest = validate(new Uint8Array(await readFile(input)))
    console.log(JSON.stringify({ valid: true, id: manifest.id, version: manifest.version, requiresMeva: manifest.requiresMeva }, null, 2))
    return
  }
  if (command !== "build") return usage()
  const entry = option(args, "--entry")
  const manifestPath = option(args, "--manifest")
  const out = option(args, "--out")
  if (!manifestPath || !out) return usage()
  const raw = JSON.parse(await readFile(manifestPath, "utf8")) as unknown
  if (isProcessorManifest(raw) || isRunnerManifest(raw)) {
    // Processor plugins are a manifest the server runs; there is no code. A
    // runner's program is a release file per platform, listed by sha256.
    const processor = isRunnerManifest(raw) ? runnerManifestSchema.parse(raw) : processorManifestSchema.parse(raw)
    const entries: Record<string, Uint8Array | string> = {
      "manifest.json": `${JSON.stringify(processor, null, 2)}\n`,
    }
    const icon = option(args, "--icon")
    const license = option(args, "--license")
    const readme = option(args, "--readme")
    if (icon) entries["icon.svg"] = await readFile(icon)
    if (license) entries.LICENSE = await readFile(license)
    if (readme) entries["README.md"] = await readFile(readme)
    const archive = createArchive(entries)
    validate(archive)
    await writeFile(out, archive)
    console.log(`Built ${out}`)
    return
  }
  if (!entry) return usage()
  if (isSourceManifest(raw)) {
    // One classic script for a Web Worker: the entry's default export is
    // the plugin (`defineSource`), left in a global Meva's worker reads.
    const manifest = sourceManifestSchema.parse(raw)
    const bundled = await build({ entryPoints: [entry], bundle: true, format: "iife", globalName: SOURCE_BUNDLE_GLOBAL, platform: "browser", target: "es2022", write: false, sourcemap: false })
    const entries: Record<string, Uint8Array | string> = {
      "manifest.json": `${JSON.stringify(manifest, null, 2)}\n`,
      "plugin.js": bundled.outputFiles[0]!.text,
    }
    const icon = option(args, "--icon")
    const license = option(args, "--license")
    const readme = option(args, "--readme")
    if (icon) entries["icon.svg"] = await readFile(icon)
    if (license) entries.LICENSE = await readFile(license)
    if (readme) entries["README.md"] = await readFile(readme)
    const archive = createArchive(entries)
    validate(archive)
    await writeFile(out, archive)
    console.log(`Built ${out}`)
    return
  }
  const manifest = pluginManifestSchema.parse(raw)
  assertPluginSource(manifest)
  const tempEntry = path.join(path.dirname(entry), `.mevax-entry-${Date.now()}.ts`)
  const source = `import plugin from ${JSON.stringify("./" + path.basename(entry))}; globalThis.__MEVA_PLUGIN_ENTRY__ = plugin; if (globalThis.mevaPlugin) { globalThis.mevaPlugin.subscribe((message) => { if (message.type === "host.init") import("@rimedot/meva-plugin-sdk").then(({ startPlugin }) => startPlugin(plugin, message.initialState)); }); }`
  await writeFile(tempEntry, source, "utf8")
  try {
    const bundled = await build({ entryPoints: [tempEntry], bundle: true, format: "iife", platform: "browser", target: "es2022", write: false, sourcemap: false })
    const icon = option(args, "--icon")
    const license = option(args, "--license")
    const entries: Record<string, Uint8Array | string> = {
      "manifest.json": `${JSON.stringify(manifest, null, 2)}\n`,
      "plugin.js": bundled.outputFiles[0]!.text,
    }
    if (icon) entries["icon.svg"] = await readFile(icon)
    if (license) entries.LICENSE = await readFile(license)
    validate(createArchive(entries))
    await writeFile(out, createArchive(entries))
    console.log(`Built ${out}`)
  } finally {
    await import("node:fs/promises").then(({ unlink }) => unlink(tempEntry).catch(() => undefined))
  }
}

void main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 })
