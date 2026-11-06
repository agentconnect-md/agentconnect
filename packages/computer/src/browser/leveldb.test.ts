import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { crc32c, readLevelDb, readLogRecords, snappyDecompress, writeLevelDb, writeLogRecords } from './leveldb.js'

const dirs: string[] = []
const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'ac-leveldb-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('leveldb', () => {
  it('computes CRC32C', () => {
    expect(crc32c(Buffer.from('123456789'))).toBe(0xe3069283)
  })

  it('decompresses snappy literals and back-references', () => {
    // Length 12, literal "abc", then a 9-byte copy from 3 back.
    const compressed = Buffer.from([12, 0x08, 0x61, 0x62, 0x63, 0x15, 3])
    expect(snappyDecompress(compressed).toString()).toBe('abcabcabcabc')
  })

  it('round-trips log records across block boundaries', () => {
    const records = [Buffer.alloc(10, 1), Buffer.alloc(70_000, 2), Buffer.alloc(32_760, 3), Buffer.from('end')]
    const read = readLogRecords(writeLogRecords(records))
    expect(read.map((record) => record.length)).toEqual(records.map((record) => record.length))
    expect(read.every((record, i) => record.equals(records[i]!))).toBe(true)
  })

  it('writes a database it reads back exactly', () => {
    const dir = join(temp(), 'db')
    const data = new Map<string, Buffer>()
    for (let i = 0; i < 2000; i++) data.set(`_https://example.com\u0000\u0001key${i}`, Buffer.alloc(700, i % 251))
    data.set('VERSION', Buffer.from('1'))
    writeLevelDb(dir, data)
    expect(readFileSync(join(dir, 'CURRENT'), 'latin1')).toBe('MANIFEST-000002\n')
    const back = readLevelDb(dir)
    expect(back.size).toBe(data.size)
    for (const [key, value] of data) expect(back.get(key)?.equals(value)).toBe(true)
  })

  it('reads an absent database as empty', () => {
    expect(readLevelDb(join(temp(), 'missing')).size).toBe(0)
  })
})
