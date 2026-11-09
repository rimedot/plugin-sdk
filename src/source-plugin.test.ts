import assert from "node:assert/strict"
import test from "node:test"
import { sourceManifestSchema } from "./source-plugin.js"

const manifest = () => ({
  formatVersion: 1,
  source: "https://github.com/rimedot/example-source",
  kind: "source",
  id: "github.com/rimedot/example-source",
  name: "Example source",
  version: "1.0.0",
  requiresMeva: ">=0.6.0",
  settings: [{ id: "site", label: "Site", type: "endpoint", default: "https://example.org" }],
  worker: { protocol: "meva-source.v1" },
  browse: { site: "example", capabilities: ["search", "artists"] },
  network: {
    hosts: ["example.org", "*.example.org"],
    local: ["192.168.1.0/24"],
    headers: [{ host: "example.org", set: { Accept: "text/css" } }],
    mediaProxy: [{ host: "*.example.org", referer: "https://example.org/" }],
  },
  urlPatterns: ["https://example.org/*/post/*"],
})

test("a source manifest matches the server's rules", () => {
  assert.equal(sourceManifestSchema.parse(manifest()).browse.site, "example")
  const ip = manifest()
  ip.network.hosts = ["127.0.0.1"]
  assert.equal(sourceManifestSchema.safeParse(ip).success, false)
  const header = manifest()
  header.network.headers = [{ host: "example.org", set: { Host: "x" } as unknown as { Accept: string } }]
  assert.equal(sourceManifestSchema.safeParse(header).success, false)
  const capability = manifest()
  capability.browse.capabilities = ["search", "search"]
  assert.equal(sourceManifestSchema.safeParse(capability).success, false)
  const identity = manifest()
  identity.id = "github.com/someone/else"
  assert.equal(sourceManifestSchema.safeParse(identity).success, false)
  const pattern = manifest()
  pattern.urlPatterns = ["example.org/post"]
  assert.equal(sourceManifestSchema.safeParse(pattern).success, false)
})
