import { z } from "zod"
import { isPluginId, sourceIdentityProblem } from "./source.js"

/**
 * Source plugins: a site in Meva's Sources page, as JavaScript
 * that runs in a Web Worker in each Meva app. The worker has no network:
 * `host.fetch` goes through the Meva server, which allows only the hosts
 * the manifest declares. Same manifest rules as the server's
 * `validate_manifest`.
 */

export const SOURCE_PROTOCOL = "meva-source.v1"
/** The global a source plugin's bundle assigns (`meva-plugin build`); Meva's worker reads its default export. */
export const SOURCE_BUNDLE_GLOBAL = "__mevaSource"

export const sourceCapabilities = [
  "search",
  "artists",
  "favorites",
  "artist-import",
  "artist-previews",
  "post-import",
  "url-import",
  /** Several sites in one plugin, each its own entry in the Source picker. */
  "sites",
  /** The rating filter (safe, questionable, explicit). */
  "ratings",
  /** Tag suggestions while typing a search. */
  "autocomplete",
] as const
export type SourceCapability = (typeof sourceCapabilities)[number]

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

const semver = z.string().regex(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/)
const settingId = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/)

const publicHost = (value: string) =>
  value.length <= 253 &&
  value.includes(".") &&
  !/^[\d.]+$/.test(value) &&
  !value.includes(":") &&
  !/\.(local|internal|localhost)$/.test(value) &&
  value.split(".").every((label) => /^[a-z0-9-]{1,63}$/.test(label))

const hostPattern = z.string().refine((value) => publicHost(value.startsWith("*.") ? value.slice(2) : value), "must be a public host name like example.com or *.example.com")

const localEntry = z.string().refine((value) => {
  const text = value.trim().toLowerCase()
  if (text === "*") return true
  const [address, bits, extra] = text.split("/")
  if (extra !== undefined) return false
  if (bits !== undefined) {
    const max = address!.includes(":") ? 128 : 32
    return /^\d{1,3}$/.test(bits) && Number(bits) <= max && /^[0-9a-f.:]+$/.test(address!)
  }
  return /^[0-9a-f.:[\]]+$/.test(text) || text.split(".").every((label) => /^[a-z0-9-]{1,63}$/.test(label))
}, "must be a host name, an IP, a range like 192.168.1.0/24, or *")

const forbiddenHeaders = ["host", "content-length", "connection", "keep-alive", "transfer-encoding", "te", "trailer", "upgrade", "proxy-authorization", "proxy-connection", "forwarded", "x-real-ip"]
const fixedHeaderName = z.string().regex(/^[A-Za-z0-9-]{1,64}$/).refine((name) => {
  const lower = name.toLowerCase()
  return !forbiddenHeaders.includes(lower) && !lower.startsWith("x-forwarded-") && !lower.startsWith("x-meva") && !lower.startsWith("proxy-")
}, "Meva does not let a plugin set this header")

const urlPattern = z.string().max(300).refine((pattern) => {
  const match = /^(https?|\*):\/\/([^/]+)(\/\S*)$/.exec(pattern)
  if (!match) return false
  const host = match[2]!
  return publicHost(host.startsWith("*.") ? host.slice(2) : host)
}, "must look like https://example.com/*/post/*")

const settingSchema = z.object({
  id: settingId.refine((id) => id !== "enabled", "this setting id is reserved"),
  label: z.string().min(1).max(120),
  /** `endpoints`: a list of http(s) addresses, such as the user's own sites. */
  type: z.enum(["text", "number", "boolean", "select", "endpoint", "endpoints"]),
  default: z.unknown(),
  description: z.string().max(500).optional(),
  min: z.number().finite().optional(),
  max: z.number().finite().optional(),
  step: z.number().finite().positive().optional(),
  options: z.array(z.tuple([z.string().min(1), z.string().min(1)])).min(1).max(64).optional(),
}).strict()

export const sourceManifestSchema = z.object({
  formatVersion: z.literal(1),
  source: z.string().max(300),
  kind: z.literal("source"),
  id: z.string().max(200).refine(isPluginId, "id must be its source, like github.com/owner/repo"),
  name: z.string().min(1).max(80),
  version: semver,
  requiresMeva: z.string().min(1).max(128),
  description: z.string().max(1000).optional(),
  publisher: z.object({ name: z.string().min(1).max(120), url: z.string().url().optional() }).strict().optional(),
  settings: z.array(settingSchema).max(32).default([]),
  worker: z.object({ protocol: z.literal(SOURCE_PROTOCOL) }).strict(),
  browse: z.object({
    /** The site name written into imported files' sidecars (`source.site`). */
    site: z.string().regex(/^[a-z0-9._-]{1,64}$/),
    capabilities: z.array(z.enum(sourceCapabilities)).max(sourceCapabilities.length),
    sections: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9-]{1,32}$/), label: z.string().min(1).max(40) }).strict()).max(8).optional(),
    /** The sites it always has (`sites`); its `sites()` adds the user's own. */
    sites: z.array(z.object({
      id: z.string().regex(/^[A-Za-z0-9-]{1,32}$/),
      label: z.string().min(1).max(40),
      site: z.string().regex(/^[a-z0-9._-]{1,64}$/),
    }).strict()).max(16).optional(),
  }).strict(),
  network: z.object({
    hosts: z.array(hostPattern).max(32).default([]),
    local: z.array(localEntry).max(16).default([]),
    headers: z.array(z.object({ host: hostPattern, set: z.record(fixedHeaderName, z.string().max(4096)) }).strict()).max(32).default([]),
    mediaProxy: z.array(z.object({ host: hostPattern, referer: z.string().url().optional() }).strict()).max(16).default([]),
  }).strict().default({}),
  urlPatterns: z.array(urlPattern).max(32).default([]),
}).strict().superRefine((manifest, context) => {
  const problem = sourceIdentityProblem(manifest.id, manifest.source)
  if (problem) context.addIssue({ code: z.ZodIssueCode.custom, path: ["id"], message: problem })
  const seen = new Set<string>()
  manifest.browse.capabilities.forEach((capability, index) => {
    if (seen.has(capability)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["browse", "capabilities", index], message: `${capability} is listed twice` })
    seen.add(capability)
  })
  manifest.settings.forEach((setting, index) => {
    if (manifest.settings.slice(0, index).some((other) => other.id === setting.id)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["settings", index, "id"], message: `${setting.id} is declared twice` })
    }
  })
})

export type SourceManifest = z.infer<typeof sourceManifestSchema>

export const isSourceManifest = (value: unknown): boolean =>
  typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "source"

// ---------------------------------------------------------------------------
// What a plugin returns (the Sources page's own shapes)
// ---------------------------------------------------------------------------

/** One file of a post, as the media dialog lists it. */
export type SourceAttachment = {
  id: string
  fileName?: string
  url: string
  previewUrl?: string | null
  mime?: string
  /** The site has only a preview of this file; nothing to download. */
  noFullImage?: boolean
  /** Importing just this file. */
  download?: SourceImportItem
}

export type SourcePost = {
  kind: "post"
  /** Unique on the site; the "already imported" and "seen" key. */
  sourceId: string
  title: string
  description?: string
  postUrl: string
  previewUrl?: string | null
  mediaUrl?: string | null
  width?: number
  height?: number
  tags: string[]
  rating?: string
  publishedAt?: string
  attachments?: SourceAttachment[]
  /** For post-import and opening the post again. */
  ref?: PostRef
}

export type SourceArtist = {
  kind: "artist"
  sourceId: string
  artistId: string
  /** The part of the site the artist is on; "" when the site has one. */
  service: string
  title: string
  description?: string
  profileUrl: string
  profileImageUrl?: string | null
  previewUrls: string[]
  recentPostCount: number
  favorite?: boolean
}

export type ArtistRef = { service: string; artistId: string; title: string }
export type PostRef = { service: string; artistId: string; postId: string }

/** One of a plugin's sites; `site` is its name in sidecars. */
export type SourceSite = { id: string; label: string; site: string }

export type FeedQuery = {
  page: number
  query: string
  section: string
  /** Which of the plugin's sites (`sites`). */
  site?: string
  /** The rating filter (`ratings`): any of "s", "q", "e", comma separated. */
  ratings?: string
  /** Browsing one artist's posts. */
  artist?: ArtistRef
  /** The artist list's filter: one of the `facets` the plugin returned. */
  facet?: string
  favoritesOnly?: boolean
}

export type FeedPage = {
  mode: "artists" | "posts"
  items: Array<SourcePost | SourceArtist>
  hasMore?: boolean
  totalCount?: number
  /** Values the artist list can be filtered by (for example a service). */
  facets?: string[]
  /** Browsing one artist: whether it is a favorite. */
  artistFavorite?: boolean
}

/** One file to import: where it is and the sidecar fields to write. */
export type SourceImportItem = {
  downloadUrl: string
  sourceUrl?: string
  fileName?: string
  subdir?: string
  metadata?: Record<string, unknown>
  headers?: Record<string, string>
  idempotencyKey?: string
}

export type ImportPlan = {
  group: { label: string; kind?: string; sourceUrl?: string }
  items: SourceImportItem[]
  /** Files left out (blocked types, nothing the library can read). */
  skipped?: number
  /** Files the site has no full version of yet. */
  noFullImage?: number
}

/** One page of a long import; `next` is where the next page starts. */
export type ImportPage = {
  items: SourceImportItem[]
  next: unknown
  skipped?: number
  noFullImage?: number
}

export type ResolvedUrl =
  | { kind: "post"; post: PostRef }
  | { kind: "artist"; artist: ArtistRef }
  | null

export type FavoritesImport = { found: number; added: number; alreadySaved: number }

// ---------------------------------------------------------------------------
// What a plugin gets
// ---------------------------------------------------------------------------

export type HostRequest = {
  method?: "GET" | "POST" | "HEAD"
  headers?: Record<string, string>
  body?: string
  /** Keep a successful GET answer this long (at most an hour), for every app. */
  cacheSeconds?: number
}

export type HostResponse = {
  status: number
  ok: boolean
  /** The final address, after redirects. */
  url: string
  headers: Record<string, string>
  text(): string
  json<T = unknown>(): T
  bytes(): Uint8Array
}

export type SourceHost = {
  /** A request through the Meva server; only the manifest's hosts. */
  fetch(url: string, request?: HostRequest): Promise<HostResponse>
  /** The plugin's own storage on the server, one file per key. */
  storage: {
    get(key: string): Promise<string | null>
    getJson<T = unknown>(key: string): Promise<T | null>
    set(key: string, value: string): Promise<void>
    setJson(key: string, value: unknown): Promise<void>
    delete(key: string): Promise<void>
    keys(): Promise<Array<{ key: string; size: number; modified?: string }>>
  }
  /** The plugin's settings, as the user set them. */
  settings: Record<string, unknown>
}

export type TagSuggestion = { value: string; label: string; count: number; category?: number | null }

export type SourcePlugin = {
  feed(query: FeedQuery, host: SourceHost): Promise<FeedPage>
  /** Every site it offers now, its own and the user's (`sites`). */
  sites?(host: SourceHost): Promise<SourceSite[]>
  autocomplete?(query: string, site: string | undefined, host: SourceHost): Promise<TagSuggestion[]>
  /** One post with every file, for the media dialog. */
  post?(ref: PostRef, host: SourceHost): Promise<FeedPage>
  importPost?(ref: PostRef, host: SourceHost): Promise<ImportPlan>
  /** Every post of an artist, a page at a time. `cursor` is null first. */
  importArtist?(artist: ArtistRef, cursor: unknown, host: SourceHost): Promise<ImportPage>
  resolveUrl?(url: string, host: SourceHost): Promise<ResolvedUrl>
  artistPreviews?(artist: ArtistRef, host: SourceHost): Promise<string[]>
  favorites?: {
    list(host: SourceHost): Promise<ArtistRef[]>
    set(artist: ArtistRef, favorite: boolean, host: SourceHost): Promise<void>
    importText(text: string, host: SourceHost): Promise<FavoritesImport>
  }
}

export const defineSource = (plugin: SourcePlugin): SourcePlugin => Object.freeze(plugin)

/** The methods the app may call, and what they map to. */
export const SOURCE_METHODS = [
  "feed",
  "sites",
  "autocomplete",
  "post",
  "importPost",
  "importArtist",
  "resolveUrl",
  "artistPreviews",
  "favorites.list",
  "favorites.set",
  "favorites.importText",
] as const
export type SourceMethod = (typeof SOURCE_METHODS)[number]

/** The host calls a worker may make. */
export const HOST_METHODS = ["fetch", "storage.get", "storage.set", "storage.delete", "storage.keys"] as const
export type HostMethod = (typeof HOST_METHODS)[number]

/**
 * Messages between the app and the worker (`meva-source.v1`):
 *
 * - app → worker: `{ type: "init", protocol, pluginId, settings }`, then
 *   `{ type: "call", id, method, args }` and `{ type: "host-result", id, ok, value | error }`.
 * - worker → app: `{ type: "ready", methods }`, `{ type: "result", id, ok, value | error }`
 *   and `{ type: "host", id, method, args }`.
 *
 * A fetch result's body is an ArrayBuffer, transferred.
 */
export type AppToWorker =
  | { type: "init"; protocol: string; pluginId: string; settings: Record<string, unknown> }
  | { type: "call"; id: number; method: SourceMethod; args: unknown[] }
  | { type: "host-result"; id: number; ok: true; value: unknown }
  | { type: "host-result"; id: number; ok: false; error: string }

export type WorkerToApp =
  | { type: "ready"; methods: SourceMethod[] }
  | { type: "result"; id: number; ok: true; value: unknown }
  | { type: "result"; id: number; ok: false; error: string }
  | { type: "host"; id: number; method: HostMethod; args: unknown[] }
