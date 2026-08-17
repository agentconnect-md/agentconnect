/**
 * The transcript store holds every message body, agent reply and tool payload the
 * daemon has seen. Every other secret-bearing artifact it writes is explicitly
 * 0600/0700; this one used to inherit the umask, so on a host whose root pre-exists
 * group/other-readable a second local account could read the lot.
 */
import { describe, it, expect } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalStore } from '../src/store/local-store.js'

const mode = (p: string) => statSync(p).mode & 0o777

describe.skipIf(process.platform === 'win32')('local store file permissions', () => {
  it('creates the state dir 0700 and the database (with its WAL siblings) 0600', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-store-perm-'))
    const dbPath = join(root, 'state', 'local.sqlite')
    const store = await LocalStore.open(dbPath)
    // A write forces the WAL siblings into existence.
    await store.insertToolCall({
      channel: 'C1',
      thread: 'T1',
      ts: '1',
      sender: 'agent-1',
      toolCallId: 'tc-1',
      title: 't',
      body: '{}'
    })

    expect(mode(join(root, 'state'))).toBe(0o700)
    expect(mode(dbPath)).toBe(0o600)
    for (const sibling of [`${dbPath}-wal`, `${dbPath}-shm`]) {
      // Present in WAL mode; they carry the same rows, so they must be narrowed too.
      expect(mode(sibling)).toBe(0o600)
    }
    await store.close()
  })

  it('repairs a state dir that already exists group/other-readable', async () => {
    // The container-image / `StateDirectory=` case: the path is laid down before the
    // daemon runs, so `mkdirSync`'s mode never applies.
    const root = mkdtempSync(join(tmpdir(), 'ac-store-perm-'))
    const dir = join(root, 'state')
    mkdirSync(dir, { recursive: true })
    chmodSync(dir, 0o755)

    const store = await LocalStore.open(join(dir, 'local.sqlite'))
    expect(mode(dir)).toBe(0o700)
    await store.close()
  })
})
