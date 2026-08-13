import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readDataPlaneConfig } from '../src/store/postgres-config.js'

function configFile(value: unknown): string {
  const file = join(mkdtempSync(join(tmpdir(), 'ac-data-plane-')), 'config.json')
  writeFileSync(file, JSON.stringify(value))
  return file
}

describe('mounted data-plane configuration', () => {
  it('accepts one install-wide PostgreSQL DSN', () => {
    expect(
      readDataPlaneConfig(configFile({ version: 1, databaseUrl: 'postgresql://daemon:secret@postgres/data_plane' }))
    ).toEqual({
      version: 1,
      databaseUrl: 'postgresql://daemon:secret@postgres/data_plane',
      maxConnections: 4
    })
  })

  it('rejects non-PostgreSQL URLs and per-org schema configuration', () => {
    expect(() => readDataPlaneConfig(configFile({ version: 1, databaseUrl: 'https://postgres/data_plane' }))).toThrow(
      /databaseUrl must be a PostgreSQL URL/
    )
    expect(() =>
      readDataPlaneConfig(configFile({ version: 1, databaseUrl: 'postgresql://postgres/data_plane', schema: 'org-a' }))
    ).toThrow(/unrecognized key/i)
  })

  it('does not include a missing file error or credential material in its message', () => {
    expect(() => readDataPlaneConfig('/definitely/missing/ac-data-plane.json')).toThrow(
      'data-plane configuration is not readable at /definitely/missing/ac-data-plane.json'
    )
  })
})
