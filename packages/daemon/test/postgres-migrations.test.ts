import { describe, expect, it, vi } from 'vitest'
import type { PoolClient } from 'pg'
import { DATA_PLANE_SCHEMA_VERSION, migrateDataPlaneSchema } from '../src/store/postgres-migrations.js'

function clientWithVersions(versions: number[]) {
  const queries: Array<{ text: string; values?: unknown[] }> = []
  const query = vi.fn(async (text: string, values?: unknown[]) => {
    queries.push({ text, values })
    return text.startsWith('SELECT version') ? { rows: versions.map((version) => ({ version })) } : { rows: [] }
  })
  return { client: { query } as unknown as PoolClient, queries }
}

describe('PostgreSQL data-plane migrations', () => {
  it('serializes first touch and records every migration before commit', async () => {
    const { client, queries } = clientWithVersions([])
    await migrateDataPlaneSchema(client, 'org_a')
    expect(queries.map(({ text }) => text.trim().split(/\s+/, 2).join(' '))).toEqual([
      'BEGIN',
      'SELECT pg_advisory_xact_lock(hashtext($1),',
      'CREATE SCHEMA',
      'SET LOCAL',
      'CREATE TABLE',
      'SELECT version',
      'CREATE SEQUENCE',
      'INSERT INTO',
      'COMMIT'
    ])
    expect(queries[1]?.values).toEqual(['org_a'])
    expect(queries.at(-2)?.values).toEqual([DATA_PLANE_SCHEMA_VERSION])
  })

  it('is idempotent when the current version is already installed', async () => {
    const { client, queries } = clientWithVersions([DATA_PLANE_SCHEMA_VERSION])
    await migrateDataPlaneSchema(client, 'org_a')
    expect(queries.some(({ text }) => text.includes('CREATE SEQUENCE transcript_revision_seq'))).toBe(false)
    expect(queries.at(-1)?.text).toBe('COMMIT')
  })

  it('rolls back instead of opening a schema written by a newer daemon', async () => {
    const { client, queries } = clientWithVersions([DATA_PLANE_SCHEMA_VERSION + 1])
    await expect(migrateDataPlaneSchema(client, 'org_a')).rejects.toThrow(/newer than supported/)
    expect(queries.at(-1)?.text).toBe('ROLLBACK')
  })
})
