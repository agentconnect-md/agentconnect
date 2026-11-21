import type { SpawnDriver, SpawnRequest } from '../acp/spawn-driver.js'

export class AntigravityHistoryError extends Error {}

// Run beside agy so HOME, the filesystem and its confinement all belong to the session.
const IMPORT_HISTORY = String.raw`
import { lstat, link, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { backup, DatabaseSync } from 'node:sqlite'

async function importHistory(id) {
  const root = join(homedir(), '.gemini')
  const legacy = join(root, 'antigravity-acp')
  const native = join(root, 'antigravity-cli')
  const sourceDir = join(legacy, 'conversations')
  const destDir = join(native, 'conversations')
  const stat = path => lstat(path).catch(error => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  for (const path of [root, legacy, sourceDir]) {
    const entry = await stat(path)
    if (!entry) return 'absent'
    if (!entry.isDirectory()) throw Error('Unexpected legacy history directory')
  }
  const source = join(sourceDir, id + '.db')
  const entry = await stat(source)
  if (!entry) return 'absent'
  if (!entry.isFile()) throw Error('Unexpected legacy history file')
  for (const path of [native, destDir]) {
    await mkdir(path, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error })
    if (!(await stat(path))?.isDirectory()) throw Error('Unexpected native history directory')
  }
  const dest = join(destDir, id + '.db')
  const existing = await stat(dest)
  if (existing?.isFile()) return 'ready'
  if (existing) throw Error('Unexpected native history file')
  for (const suffix of ['-wal', '-shm', '-journal']) {
    const sidecar = await stat(source + suffix)
    if (sidecar && !sidecar.isFile()) throw Error('Unexpected SQLite sidecar')
  }
  const stage = await mkdtemp(join(destDir, '.import-'))
  try {
    const snapshot = join(stage, 'history.db')
    const db = new DatabaseSync(source, { readOnly: true })
    try { await backup(db, snapshot) } finally { db.close() }
    try { await link(snapshot, dest) } catch (error) {
      if (error.code !== 'EEXIST' || !(await stat(dest))?.isFile()) throw error
    }
    return 'ready'
  } finally {
    await rm(stage, { recursive: true, force: true })
  }
}
process.umask(0o077)
process.stdout.write(await importHistory(process.argv[1]))
`

export async function importAntigravityHistory(
  driver: SpawnDriver,
  launch: Pick<SpawnRequest, 'env' | 'hostKey' | 'sandbox'>,
  id: string
): Promise<boolean> {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) return false
  try {
    const child = await driver.launch({
      command: 'node',
      args: ['--input-type=module', '-e', IMPORT_HISTORY, id],
      env: launch.env,
      hostKey: launch.hostKey,
      sandbox: launch.sandbox,
      suppressChildStderr: true
    })
    try {
      const stream = child.fromAgent.pipeThrough(new TransformStream<Uint8Array, Uint8Array>(), {
        signal: AbortSignal.timeout(60_000)
      })
      const output = await new Response(stream).text()
      if (output === 'absent') return false
      if (output !== 'ready') throw Error('History snapshot was not published')
      return true
    } finally {
      await child.stop(2000)
    }
  } catch (cause) {
    throw new AntigravityHistoryError('Could not import the saved Antigravity session. Retry to resume it.', { cause })
  }
}
