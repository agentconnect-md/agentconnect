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

/**
 * Copy only OMP's credential schema and rows into a fresh private database.
 * Reviewed against can1357/oh-my-pi b0d04e517335ada4e00ef8dc93aad9f4d1be8d21.
 */
export function extractOmpCredentials(sourcePath: string, destinationPath: string): void {
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
    // Pin all allowlisted reads to one snapshot. This matters in WAL mode: without
    // a source-side transaction, the two table reads can observe different commits.
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
        insert.run(...columns.map((column) => row[column] ?? null))
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
