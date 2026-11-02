import { Inflate, strFromU8, zipSync } from "fflate"

export const MAX_ARCHIVE_BYTES = 10 * 1024 * 1024
export const MAX_TOTAL_UNCOMPRESSED_BYTES = 25 * 1024 * 1024
export const MAX_ENTRIES = 16

const forbiddenPath = (value: string) => value.startsWith("/") || /^[A-Za-z]:/.test(value) || value.includes("\\") || value.split("/").some((part) => !part || part === "." || part === ".." || part.includes("\0"))

type ArchiveEntry = { name: string; method: number; offset: number; size: number; originalSize: number }

// Validate every directory record before allocating output. ZIP64 and split
// archives cannot be produced by the bounded .mevax builder.
const inspectArchive = (bytes: Uint8Array): ArchiveEntry[] => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const invalid = () => { throw new Error("Malformed .mevax ZIP archive") }
  const range = (offset: number, size: number) => {
    if (offset < 0 || size < 0 || offset + size > bytes.length) invalid()
  }
  const u16 = (offset: number) => { range(offset, 2); return view.getUint16(offset, true) }
  const u32 = (offset: number) => { range(offset, 4); return view.getUint32(offset, true) }
  let end = bytes.length - 22
  while (end >= Math.max(0, bytes.length - 65557)) {
    if (u32(end) === 0x06054b50 && end + 22 + u16(end + 20) === bytes.length) break
    end--
  }
  if (end < Math.max(0, bytes.length - 65557)) invalid()
  if (u16(end + 4) || u16(end + 6) || u16(end + 8) !== u16(end + 10)) invalid()
  const count = u16(end + 10)
  if (count > MAX_ENTRIES) throw new Error(".mevax package has too many entries")
  const directory = u32(end + 16)
  if (directory + u32(end + 12) !== end) invalid()
  const entries: ArchiveEntry[] = []
  const names = new Set<string>()
  let cursor = directory
  let total = 0
  for (let i = 0; i < count; i++) {
    range(cursor, 46)
    if (u32(cursor) !== 0x02014b50) invalid()
    const flags = u16(cursor + 8)
    const method = u16(cursor + 10)
    const size = u32(cursor + 20)
    const originalSize = u32(cursor + 24)
    const nameLength = u16(cursor + 28)
    const next = cursor + 46 + nameLength + u16(cursor + 30) + u16(cursor + 32)
    if (next > end || u16(cursor + 34) || (flags & ~0x080e) || (method !== 0 && method !== 8)) invalid()
    total += originalSize
    if (total > MAX_TOTAL_UNCOMPRESSED_BYTES) throw new Error(".mevax package expands beyond the size limit")
    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLength)
    const name = strFromU8(nameBytes, !(flags & 0x0800))
    if (forbiddenPath(name)) throw new Error(`Unsafe .mevax archive path: ${name}`)
    if (names.has(name)) throw new Error("Duplicate .mevax archive entry")
    names.add(name)
    const local = u32(cursor + 42)
    range(local, 30)
    if (u32(local) !== 0x04034b50 || u16(local + 6) !== flags || u16(local + 8) !== method || u16(local + 26) !== nameLength) invalid()
    const offset = local + 30 + nameLength + u16(local + 28)
    if (offset + size > directory) invalid()
    for (let n = 0; n < nameLength; n++) if (bytes[local + 30 + n] !== nameBytes[n]) invalid()
    if (!(flags & 8) && (u32(local + 18) !== size || u32(local + 22) !== originalSize)) invalid()
    if (method === 0 && size !== originalSize) invalid()
    // Reject aliased local records rather than counting the same compressed
    // payload repeatedly under different names.
    for (const previous of entries) if (local < previous.offset + previous.size && offset + size > previous.offset) invalid()
    entries.push({ name, method, offset, size, originalSize })
    cursor = next
  }
  if (cursor !== end) invalid()
  return entries
}

export const validateArchiveEntries = (bytes: Uint8Array) => {
  if (bytes.byteLength > MAX_ARCHIVE_BYTES) throw new Error(".mevax package is too large")
  const directory = inspectArchive(bytes)
  const entries: Record<string, Uint8Array<ArrayBuffer>> = Object.create(null)
  for (const entry of directory) {
    const compressed = bytes.subarray(entry.offset, entry.offset + entry.size)
    if (entry.method === 0) {
      entries[entry.name] = compressed.slice()
      continue
    }
    const output = new Uint8Array(entry.originalSize)
    let written = 0
    const inflate = new Inflate((chunk) => {
      if (written + chunk.length > output.length) throw new Error(".mevax entry expands beyond its declared size")
      output.set(chunk, written)
      written += chunk.length
    })
    // Each DEFLATE input chunk has bounded expansion, independent of a forged
    // header. Stop on the first excess chunk instead of inflating the archive.
    for (let offset = 0; offset < compressed.length; offset += 1024) {
      const end = Math.min(offset + 1024, compressed.length)
      inflate.push(compressed.subarray(offset, end), end === compressed.length)
    }
    if (!compressed.length || written !== output.length) throw new Error(".mevax entry does not match its declared size")
    entries[entry.name] = output
  }
  return entries
}

export const createArchive = (entries: Record<string, Uint8Array | string>) => {
  const normalized: Record<string, Uint8Array> = {}
  for (const [name, value] of Object.entries(entries)) {
    if (forbiddenPath(name)) throw new Error(`Unsafe .mevax archive path: ${name}`)
    normalized[name] = typeof value === "string" ? new TextEncoder().encode(value) : value
  }
  return zipSync(normalized, { level: 6 })
}
