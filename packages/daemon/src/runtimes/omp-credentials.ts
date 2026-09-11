import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'

const TABLES = ['auth_credentials', 'auth_schema_version'] as const
const MAX_ROW_BYTES = 256 * 1024
const MAX_TOTAL_BYTES = 1024 * 1024
const MAX_DESTINATION_BYTES = 2 * 1024 * 1024

function quoted(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`
}

function valueBytes(value: SQLInputValue): number {
  if (typeof value === 'string') return Buffer.byteLength(value)
  if (value instanceof Uint8Array) return value.byteLength
  return value === null ? 0 : 8
}

function rowBytes(row: Record<string, SQLInputValue>): number {
  return Object.values(row).reduce<number>((total, value) => total + valueBytes(value), 0)
}

// Query provider names only; expired or disabled logins remain discoverable for reauthentication.
export function discoverOmpCredentialProviders(sourcePath: string): string[] {
  let source: DatabaseSync | undefined
  try {
    if (!lstatSync(sourcePath).isFile()) return []
    source = new DatabaseSync(sourcePath, { readOnly: true })
    return source
      .prepare(
        `
      SELECT DISTINCT provider FROM auth_credentials
      WHERE typeof(provider) = 'text' AND length(trim(provider)) > 0
        AND length(data) <= ${MAX_ROW_BYTES}
        AND CASE WHEN json_valid(data) THEN
          (credential_type = 'api_key' AND json_type(data, '$.key') = 'text'
            AND length(trim(json_extract(data, '$.key'))) > 0)
          OR (credential_type = 'oauth' AND (
            (json_type(data, '$.access') = 'text' AND length(trim(json_extract(data, '$.access'))) > 0)
            OR (json_type(data, '$.refresh') = 'text' AND length(trim(json_extract(data, '$.refresh'))) > 0)))
        ELSE 0 END
      ORDER BY provider
    `
      )
      .all()
      .map((row) => String(row.provider))
  } catch {
    return []
  } finally {
    source?.close()
  }
}

export interface OmpApiCredential {
  id: number
  provider: string
  key: string
}

export function readOmpApiCredentials(sourcePath: string): OmpApiCredential[] {
  let source: DatabaseSync | undefined
  try {
    const stat = lstatSync(sourcePath)
    if (stat.isSymbolicLink()) return []
    if (!stat.isFile()) throw new Error('invalid source')
    source = new DatabaseSync(sourcePath, { readOnly: true })
    source.exec('PRAGMA trusted_schema=OFF')
    const credentials: OmpApiCredential[] = []
    let bytes = 0
    for (const row of source
      .prepare("SELECT id, provider, data FROM auth_credentials WHERE credential_type = 'api_key'")
      .iterate()) {
      if (typeof row.id !== 'number' || typeof row.provider !== 'string' || typeof row.data !== 'string')
        throw new Error('invalid credential')
      bytes += Buffer.byteLength(row.data)
      if (Buffer.byteLength(row.data) > MAX_ROW_BYTES || bytes > MAX_TOTAL_BYTES)
        throw new Error('oversized credentials')
      const data = JSON.parse(row.data) as { key?: unknown }
      if (typeof data?.key === 'string' && data.key.trim())
        credentials.push({ id: row.id, provider: row.provider, key: data.key })
    }
    return credentials
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw new Error('Cannot read the OMP API credential database')
  } finally {
    source?.close()
  }
}

// Copy only native credential tables; projection runs before any row reaches the private database or journal.
export function extractOmpCredentials(
  sourcePath: string,
  destinationPath: string,
  project: (row: Record<string, SQLInputValue>) => Record<string, SQLInputValue> = (row) => row
): void {
  if (!existsSync(sourcePath)) return
  if (existsSync(destinationPath)) {
    if (lstatSync(destinationPath).isSymbolicLink()) {
      throw new Error(`OMP credential destination is a symlink: ${destinationPath}`)
    }
    return
  }
  const sourceStat = lstatSync(sourcePath)
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) return

  mkdirSync(dirname(destinationPath), { recursive: true, mode: 0o700 })
  const tempDir = mkdtempSync(join(dirname(destinationPath) || tmpdir(), '.omp-credentials-'))
  const tempPath = join(tempDir, basename(destinationPath))
  let source: DatabaseSync | undefined
  let destination: DatabaseSync | undefined
  let sourceTransaction = false
  try {
    source = new DatabaseSync(sourcePath, { readOnly: true })
    // Keep both allowlisted tables on the same WAL snapshot.
    source.exec('BEGIN')
    sourceTransaction = true
    destination = new DatabaseSync(tempPath)
    destination.exec('BEGIN IMMEDIATE')
    let totalBytes = 0

    for (const table of TABLES) {
      const schema = source.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as
        { sql?: unknown } | undefined
      if (typeof schema?.sql !== 'string' || !/^CREATE\s+TABLE\b/i.test(schema.sql)) {
        throw new Error(`OMP credential source is missing allowlisted table ${table}`)
      }
      destination.exec(schema.sql)

      const columns = source
        .prepare(`PRAGMA table_info(${quoted(table)})`)
        .all()
        .map((column) => String(column.name))
      if (columns.length === 0) throw new Error(`OMP credential table ${table} has no columns`)
      const columnList = columns.map(quoted).join(', ')
      const placeholders = columns.map(() => '?').join(', ')
      const insert = destination.prepare(`INSERT INTO ${quoted(table)} (${columnList}) VALUES (${placeholders})`)
      const rows = source.prepare(`SELECT ${columnList} FROM ${quoted(table)}`).all() as Array<
        Record<string, SQLInputValue>
      >
      for (const row of rows) {
        const bytes = rowBytes(row)
        if (bytes > MAX_ROW_BYTES) throw new Error(`OMP credential row exceeds ${MAX_ROW_BYTES} bytes`)
        totalBytes += bytes
        if (totalBytes > MAX_TOTAL_BYTES) {
          throw new Error(`OMP credential payload exceeds ${MAX_TOTAL_BYTES} bytes`)
        }
        const projected = table === 'auth_credentials' ? project(row) : row
        insert.run(...columns.map((column) => projected[column] ?? null))
      }
    }

    destination.exec('COMMIT')
    source.exec('COMMIT')
    sourceTransaction = false
    destination.close()
    destination = undefined
    if (statSync(tempPath).size > MAX_DESTINATION_BYTES) {
      throw new Error(`OMP private credential database exceeds ${MAX_DESTINATION_BYTES} bytes`)
    }
    chmodSync(tempPath, 0o600)
    renameSync(tempPath, destinationPath)
  } catch (error) {
    try {
      destination?.exec('ROLLBACK')
    } catch {
      // The transaction may not have started or may already be closed.
    }
    if (sourceTransaction) {
      try {
        source?.exec('ROLLBACK')
      } catch {
        // The read transaction may already have been closed.
      }
    }
    throw error
  } finally {
    destination?.close()
    source?.close()
    rmSync(tempDir, { recursive: true, force: true })
  }
}
