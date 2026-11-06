// A minimal LevelDB reader and writer for Chromium's localStorage (computer-use.md §3.10); no native binding.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const BLOCK_SIZE = 32 * 1024
const HEADER_SIZE = 7
const FULL = 1
const FIRST = 2
const MIDDLE = 3
const LAST = 4
const TYPE_DELETION = 0
const TYPE_VALUE = 1
const TABLE_MAGIC = 0xdb4775248b80fb57n
const BATCH_LIMIT_BYTES = 1024 * 1024

// ---- CRC32C (Castagnoli), as LevelDB masks it in log records ----

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0x82f63b78 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

export function crc32c(data: Uint8Array, initial = 0): number {
  let crc = ~initial >>> 0
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  return ~crc >>> 0
}

function maskCrc(crc: number): number {
  return (((crc >>> 15) | (crc << 17)) + 0xa282ead8) >>> 0
}

// ---- varints and slices ----

class Reader {
  constructor(
    readonly buf: Buffer,
    public pos = 0
  ) {}

  get done(): boolean {
    return this.pos >= this.buf.length
  }

  varint(): number {
    let result = 0
    let shift = 0
    for (;;) {
      if (this.pos >= this.buf.length) throw new Error('leveldb: truncated varint')
      const byte = this.buf[this.pos++]!
      result += (byte & 0x7f) * 2 ** shift
      if (!(byte & 0x80)) return result
      shift += 7
      if (shift > 63) throw new Error('leveldb: varint too long')
    }
  }

  bytes(length: number): Buffer {
    if (this.pos + length > this.buf.length) throw new Error('leveldb: truncated slice')
    const out = this.buf.subarray(this.pos, this.pos + length)
    this.pos += length
    return out
  }

  slice(): Buffer {
    return this.bytes(this.varint())
  }
}

function varint(value: number): Buffer {
  const out: number[] = []
  let v = value
  while (v >= 0x80) {
    out.push((v % 0x80) | 0x80)
    v = Math.floor(v / 0x80)
  }
  out.push(v)
  return Buffer.from(out)
}

function lengthPrefixed(data: Buffer): Buffer {
  return Buffer.concat([varint(data.length), data])
}

// ---- snappy (raw block format, decompression only) ----

export function snappyDecompress(input: Buffer): Buffer {
  const reader = new Reader(input)
  const length = reader.varint()
  const out = Buffer.alloc(length)
  let o = 0
  while (!reader.done) {
    const tag = input[reader.pos++]!
    const kind = tag & 3
    if (kind === 0) {
      let len = tag >>> 2
      if (len >= 60) {
        const extra = len - 59
        len = input.readUIntLE(reader.pos, extra)
        reader.pos += extra
      }
      len += 1
      input.copy(out, o, reader.pos, reader.pos + len)
      reader.pos += len
      o += len
      continue
    }
    let len: number
    let offset: number
    if (kind === 1) {
      len = ((tag >>> 2) & 7) + 4
      offset = ((tag >>> 5) << 8) | input[reader.pos++]!
    } else if (kind === 2) {
      len = (tag >>> 2) + 1
      offset = input.readUInt16LE(reader.pos)
      reader.pos += 2
    } else {
      len = (tag >>> 2) + 1
      offset = input.readUInt32LE(reader.pos)
      reader.pos += 4
    }
    if (offset === 0 || offset > o) throw new Error('leveldb: bad snappy offset')
    for (let i = 0; i < len; i++, o++) out[o] = out[o - offset]!
  }
  if (o !== length) throw new Error('leveldb: snappy length mismatch')
  return out
}

// ---- log files (the write-ahead log and the MANIFEST share this format) ----

export function readLogRecords(data: Buffer): Buffer[] {
  const records: Buffer[] = []
  let pending: Buffer[] | undefined
  let pos = 0
  while (pos < data.length) {
    const left = BLOCK_SIZE - (pos % BLOCK_SIZE)
    if (left < HEADER_SIZE) {
      pos += left
      continue
    }
    if (pos + HEADER_SIZE > data.length) break
    const length = data.readUInt16LE(pos + 4)
    const type = data[pos + 6]!
    if (type === 0 && length === 0) {
      // Preallocated zeros: the rest of this block holds nothing.
      pos += left
      continue
    }
    if (pos + HEADER_SIZE + length > data.length) break
    const payload = data.subarray(pos + HEADER_SIZE, pos + HEADER_SIZE + length)
    pos += HEADER_SIZE + length
    if (type === FULL) {
      records.push(Buffer.from(payload))
      pending = undefined
    } else if (type === FIRST) pending = [payload]
    else if (type === MIDDLE && pending) pending.push(payload)
    else if (type === LAST && pending) {
      pending.push(payload)
      records.push(Buffer.concat(pending))
      pending = undefined
    }
  }
  return records
}

export function writeLogRecords(records: Buffer[]): Buffer {
  const chunks: Buffer[] = []
  let offset = 0
  const emit = (type: number, payload: Buffer): void => {
    const header = Buffer.alloc(HEADER_SIZE)
    header.writeUInt32LE(maskCrc(crc32c(payload, crc32c(Buffer.from([type])))), 0)
    header.writeUInt16LE(payload.length, 4)
    header[6] = type
    chunks.push(header, payload)
    offset += HEADER_SIZE + payload.length
  }
  for (const record of records) {
    let pos = 0
    let first = true
    do {
      let left = BLOCK_SIZE - (offset % BLOCK_SIZE)
      if (left < HEADER_SIZE) {
        chunks.push(Buffer.alloc(left))
        offset += left
        left = BLOCK_SIZE
      }
      const take = Math.min(left - HEADER_SIZE, record.length - pos)
      const end = pos + take === record.length
      emit(first && end ? FULL : first ? FIRST : end ? LAST : MIDDLE, record.subarray(pos, pos + take))
      pos += take
      first = false
    } while (pos < record.length)
  }
  return Buffer.concat(chunks)
}

// ---- entries ----

interface Entry {
  sequence: bigint
  deleted: boolean
  value: Buffer
}

type Entries = Map<string, Entry>

function apply(entries: Entries, key: Buffer, sequence: bigint, deleted: boolean, value: Buffer): void {
  const id = key.toString('latin1')
  const current = entries.get(id)
  if (!current || current.sequence < sequence) entries.set(id, { sequence, deleted, value: Buffer.from(value) })
}

function applyBatch(entries: Entries, batch: Buffer): void {
  if (batch.length < 12) return
  let sequence = batch.readBigUInt64LE(0)
  const count = batch.readUInt32LE(8)
  const reader = new Reader(batch, 12)
  for (let i = 0; i < count; i++, sequence++) {
    const type = batch[reader.pos++]
    if (type === TYPE_VALUE) {
      const key = reader.slice()
      apply(entries, key, sequence, false, reader.slice())
    } else if (type === TYPE_DELETION) apply(entries, reader.slice(), sequence, true, Buffer.alloc(0))
    else throw new Error('leveldb: unknown write batch record')
  }
}

function blockEntries(block: Buffer, each: (key: Buffer, value: Buffer) => void): void {
  if (block.length < 4) return
  const restarts = block.readUInt32LE(block.length - 4)
  const end = block.length - 4 - restarts * 4
  const reader = new Reader(block.subarray(0, end))
  let last = Buffer.alloc(0)
  while (!reader.done) {
    const shared = reader.varint()
    const unshared = reader.varint()
    const valueLength = reader.varint()
    const key = Buffer.concat([last.subarray(0, shared), reader.bytes(unshared)])
    each(key, reader.bytes(valueLength))
    last = key
  }
}

function readBlock(file: Buffer, handle: Reader): Buffer {
  const offset = handle.varint()
  const size = handle.varint()
  const contents = file.subarray(offset, offset + size)
  const compression = file[offset + size]
  if (compression === 0) return contents
  if (compression === 1) return snappyDecompress(contents)
  throw new Error(`leveldb: unsupported block compression ${compression}`)
}

function readTable(file: Buffer, entries: Entries): void {
  if (file.length < 48) throw new Error('leveldb: table too short')
  const footer = file.subarray(file.length - 48)
  if (footer.readBigUInt64LE(40) !== TABLE_MAGIC) throw new Error('leveldb: bad table magic')
  const handles = new Reader(footer)
  handles.varint()
  handles.varint()
  const index = readBlock(file, handles)
  blockEntries(index, (_key, handle) => {
    blockEntries(readBlock(file, new Reader(handle)), (internal, value) => {
      const tag = internal.readBigUInt64LE(internal.length - 8)
      apply(entries, internal.subarray(0, internal.length - 8), tag >> 8n, Number(tag & 0xffn) === TYPE_DELETION, value)
    })
  })
}

interface Manifest {
  logNumber: number
  prevLogNumber: number
  tables: Set<number>
}

function readManifest(data: Buffer): Manifest {
  const manifest: Manifest = { logNumber: 0, prevLogNumber: 0, tables: new Set() }
  for (const record of readLogRecords(data)) {
    const reader = new Reader(record)
    while (!reader.done) {
      const tag = reader.varint()
      if (tag === 1) reader.slice()
      else if (tag === 2) manifest.logNumber = reader.varint()
      else if (tag === 3) reader.varint()
      else if (tag === 4) reader.varint()
      else if (tag === 5) {
        reader.varint()
        reader.slice()
      } else if (tag === 6) {
        reader.varint()
        manifest.tables.delete(reader.varint())
      } else if (tag === 7) {
        reader.varint()
        manifest.tables.add(reader.varint())
        reader.varint()
        reader.slice()
        reader.slice()
      } else if (tag === 9) manifest.prevLogNumber = reader.varint()
      else throw new Error(`leveldb: unknown manifest tag ${tag}`)
    }
  }
  return manifest
}

/** Every live key and value of a closed (or copied) LevelDB directory; an absent directory reads as empty. */
export function readLevelDb(dir: string): Map<string, Buffer> {
  const entries: Entries = new Map()
  if (!existsSync(join(dir, 'CURRENT'))) return new Map()
  const current = readFileSync(join(dir, 'CURRENT'), 'latin1').trim()
  const manifest = readManifest(readFileSync(join(dir, current)))
  const files = readdirSync(dir)
  for (const number of manifest.tables) {
    const name = [`${String(number).padStart(6, '0')}.ldb`, `${String(number).padStart(6, '0')}.sst`].find((n) =>
      files.includes(n)
    )
    if (!name) throw new Error(`leveldb: table ${number} is missing`)
    readTable(readFileSync(join(dir, name)), entries)
  }
  for (const name of files) {
    const match = /^(\d+)\.log$/.exec(name)
    if (!match) continue
    const number = Number(match[1])
    if (number < manifest.logNumber && number !== manifest.prevLogNumber) continue
    for (const batch of readLogRecords(readFileSync(join(dir, name)))) applyBatch(entries, batch)
  }
  const out = new Map<string, Buffer>()
  for (const [key, entry] of entries) if (!entry.deleted) out.set(key, entry.value)
  return out
}

/** Replaces a closed LevelDB directory with a fresh database holding exactly these entries; LevelDB loads them on open. */
export function writeLevelDb(dir: string, data: Map<string, Buffer>): void {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const batches: Buffer[] = []
  let sequence = 1n
  let records: Buffer[] = []
  let bytes = 0
  const flush = (): void => {
    if (!records.length) return
    const head = Buffer.alloc(12)
    head.writeBigUInt64LE(sequence, 0)
    head.writeUInt32LE(records.length, 8)
    batches.push(Buffer.concat([head, ...records]))
    sequence += BigInt(records.length)
    records = []
    bytes = 0
  }
  for (const [key, value] of data) {
    const record = Buffer.concat([
      Buffer.from([TYPE_VALUE]),
      lengthPrefixed(Buffer.from(key, 'latin1')),
      lengthPrefixed(value)
    ])
    records.push(record)
    bytes += record.length
    if (bytes >= BATCH_LIMIT_BYTES) flush()
  }
  flush()
  const edit = Buffer.concat([
    varint(1),
    lengthPrefixed(Buffer.from('leveldb.BytewiseComparator', 'latin1')),
    varint(2),
    varint(3),
    varint(3),
    varint(4),
    varint(4),
    varint(0)
  ])
  writeFileSync(join(dir, '000003.log'), writeLogRecords(batches))
  writeFileSync(join(dir, 'MANIFEST-000002'), writeLogRecords([edit]))
  writeFileSync(join(dir, 'CURRENT'), 'MANIFEST-000002\n')
}
