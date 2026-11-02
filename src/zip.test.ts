import test from "node:test"
import assert from "node:assert/strict"
import { createArchive, validateArchiveEntries, MAX_TOTAL_UNCOMPRESSED_BYTES } from "./zip.js"

const headerOffset = (bytes: Uint8Array, signature: number) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let offset = 0; offset <= bytes.length - 4; offset++) if (view.getUint32(offset, true) === signature) return offset
  throw new Error("Fixture header missing")
}

test("archive rejects oversized declared output before decoding corrupt compressed bytes", () => {
  const bytes = createArchive({ "plugin.js": "plugin code" })
  const central = headerOffset(bytes, 0x02014b50)
  const local = headerOffset(bytes, 0x04034b50)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  view.setUint32(central + 24, MAX_TOTAL_UNCOMPRESSED_BYTES + 1, true)
  view.setUint32(local + 22, MAX_TOTAL_UNCOMPRESSED_BYTES + 1, true)
  // Reserved DEFLATE block type. Inflation must never be reached.
  bytes[local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true)] = 7
  assert.throws(() => validateArchiveEntries(bytes), /expands beyond the size limit/)
})

test("archive preflights the total size and entry count before decoding any payload", () => {
  const entries = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`file-${i}`, "x"]))
  assert.throws(() => validateArchiveEntries(createArchive(entries)), /too many entries/)
  const bytes = createArchive({ first: "first", second: "second" })
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let offset = 0; offset < bytes.length - 26; offset++) {
    if (view.getUint32(offset, true) === 0x02014b50) view.setUint32(offset + 24, 13 * 1024 * 1024, true)
    if (view.getUint32(offset, true) === 0x04034b50) view.setUint32(offset + 22, 13 * 1024 * 1024, true)
  }
  assert.throws(() => validateArchiveEntries(bytes), /expands beyond the size limit/)
})

test("archive checks actual DEFLATE output against forged small headers", () => {
  const bytes = createArchive({ "plugin.js": new Uint8Array(2 * 1024 * 1024) })
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  view.setUint32(headerOffset(bytes, 0x02014b50) + 24, 16, true)
  view.setUint32(headerOffset(bytes, 0x04034b50) + 22, 16, true)
  assert.throws(() => validateArchiveEntries(bytes), /expands beyond its declared size/)
})

test("archive rejects malformed directory counts, local offsets and duplicate entries", () => {
  const original = createArchive({ first: "first", other: "other" })
  for (const mutate of [
    (bytes: Uint8Array, view: DataView) => view.setUint16(headerOffset(bytes, 0x06054b50) + 10, 1, true),
    (bytes: Uint8Array, view: DataView) => view.setUint32(headerOffset(bytes, 0x02014b50) + 42, 0xfffffffe, true),
    (bytes: Uint8Array, view: DataView) => view.setUint32(headerOffset(bytes, 0x02014b50) + 20, 0xffffffff, true),
  ]) {
    const bytes = original.slice()
    mutate(bytes, new DataView(bytes.buffer))
    assert.throws(() => validateArchiveEntries(bytes), /Malformed/)
  }
  const duplicate = original.slice()
  const text = new TextEncoder().encode("other")
  for (let offset = 0; offset < duplicate.length - text.length; offset++) {
    if (text.every((byte, index) => duplicate[offset + index] === byte)) duplicate.set(new TextEncoder().encode("first"), offset)
  }
  assert.throws(() => validateArchiveEntries(duplicate), /Duplicate/)
  for (const bytes of [new Uint8Array(), original.subarray(0, 10), original.subarray(0, original.length - 1)]) {
    assert.throws(() => validateArchiveEntries(bytes), /Malformed/)
  }
})

test("archive preserves bounded stored and compressed binary payloads", async () => {
  const { zipSync } = await import("fflate")
  const payload = new Uint8Array(200_000).map((_, i) => i % 251)
  for (const level of [0, 6] as const) {
    const entries = validateArchiveEntries(zipSync({ "plugin.js": payload, "LICENSE": new Uint8Array() }, { level }))
    assert.deepEqual(entries["plugin.js"], payload)
    assert.equal(entries.LICENSE!.length, 0)
  }
})

test("archive accepts bounded streaming ZIP data descriptors", async () => {
  const { Zip, ZipDeflate } = await import("fflate")
  const chunks: Uint8Array[] = []
  const zip = new Zip((error, data) => { if (error) throw error; chunks.push(data) })
  const entry = new ZipDeflate("plugin.js")
  zip.add(entry)
  entry.push(new TextEncoder().encode("// streamed "), false)
  entry.push(new TextEncoder().encode("plugin"), true)
  zip.end()
  const archive = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0))
  let offset = 0
  for (const chunk of chunks) { archive.set(chunk, offset); offset += chunk.length }
  assert.equal(new TextDecoder().decode(validateArchiveEntries(archive)["plugin.js"]), "// streamed plugin")
})
