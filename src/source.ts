/**
 * A plugin's source and the id it gives: `source` is the HTTPS
 * address of the plugin's repository, and the id is `github.com/<owner>/<repo>`
 * (`<host>/<path>` elsewhere). Meva's own plugins live in Meva's repository
 * and keep their reverse-DNS ids. Same rules as Meva's server.
 */

export const MEVA_SOURCE = "https://github.com/rimexe0/meva"
export const MEVA_SOURCE_ID = "github.com/rimexe0/meva"

const segment = /^[A-Za-z0-9._-]{1,100}$/
const reverseDns = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/

const segmentOk = (value: string) => segment.test(value) && value !== "." && value !== ".."

export type PluginSource = { url: string; id: string; host: string; github: { owner: string; repo: string } | null }

/** Reads a manifest's `source`; throws with a message that says what is wrong. */
export const parseSource = (value: string): PluginSource => {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    throw new Error("source must be the HTTPS address of the plugin's repository")
  }
  if (url.protocol !== "https:") throw new Error("source must be an https:// address")
  if (url.username || url.password || url.port) throw new Error("source must be a plain https://host/path address")
  if (url.search || url.hash) throw new Error("source must not have a query or fragment")
  const host = url.hostname.toLowerCase().replace(/^www\./, "")
  if (!host.includes(".") || /^[\d.]+$/.test(host) || host.includes(":") || !segmentOk(host)) {
    throw new Error("source must name a public host")
  }
  const segments = url.pathname.split("/").filter(Boolean)
  if (segments.length) segments[segments.length - 1] = segments[segments.length - 1]!.replace(/\.git$/, "")
  if (!segments.length || segments.length > 6 || !segments.every(segmentOk)) {
    throw new Error("source must be a repository address like https://github.com/owner/repo")
  }
  let github: PluginSource["github"] = null
  if (host === "github.com") {
    if (segments.length !== 2) throw new Error("A GitHub source is the repository itself: https://github.com/owner/repo")
    github = { owner: segments[0]!, repo: segments[1]! }
  }
  const path = segments.join("/")
  return { url: `https://${host}/${path}`, id: `${host}/${path}`.toLowerCase(), host, github }
}

/** The plugin id a source gives. */
export const pluginIdFromSource = (source: string) => parseSource(source).id

/** An id made from a source: lowercase `host/path` segments. */
export const isSourceId = (value: string) => {
  const parts = value.split("/")
  return value.length <= 200 && parts.length >= 2 && parts[0]!.includes(".") && parts.every((part) => segmentOk(part) && part === part.toLowerCase())
}

/** A plugin id: one made from its source, or a reverse-DNS id of Meva's own plugins. */
export const isPluginId = (value: string) => isSourceId(value) || (reverseDns.test(value) && value.length <= 128)

/** The problem with a manifest's id and source, or null when they agree. */
export const sourceIdentityProblem = (id: string, source: string | undefined): string | null => {
  if (!source) {
    return `The manifest needs a source: the https address of the plugin's repository, like "source": "https://github.com/owner/repo". Its id is then github.com/owner/repo.`
  }
  let parsed: PluginSource
  try {
    parsed = parseSource(source)
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  if (id === parsed.id) return null
  if (parsed.id === MEVA_SOURCE_ID && reverseDns.test(id)) return null
  return `This plugin says its id is ${id}, but its source ${parsed.url} makes it ${parsed.id}.`
}
