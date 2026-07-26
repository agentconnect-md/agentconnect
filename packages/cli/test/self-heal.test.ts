/**
 * `selfHealCliEntry` runs before anything else on every CLI invocation, so it is
 * normally the code that CREATES `<root>`. With the default umask that landed at
 * 0755, while every other creator of the same directory passes 0o700 — leaving the
 * transcript store and daemon logs beneath it traversable by other local users.
 */
import { describe, it, expect } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cliEntryPath } from '../src/paths.js'
import { selfHealCliEntry } from '../src/self-heal.js'

const mode = (p: string) => statSync(p).mode & 0o777
const newRoot = () => join(mkdtempSync(join(tmpdir(), 'ac-selfheal-')), 'root')

describe.skipIf(process.platform === 'win32')('selfHealCliEntry', () => {
  it('creates the root 0700 and writes the entry pointer', () => {
    const root = newRoot()
    selfHealCliEntry(root, '/opt/agentconnect/cli.js')

    const entry = cliEntryPath(root)
    expect(existsSync(entry)).toBe(true)
    expect(readFileSync(entry, 'utf8')).toBe('/opt/agentconnect/cli.js\n')
    expect(mode(root)).toBe(0o700)
  })

  it('repairs a root that already exists group/other-readable', () => {
    // `mkdirSync`'s mode does not apply to an existing directory, so a root created
    // by an older CLI, a container image, or systemd `StateDirectory=` keeps 0755
    // unless it is explicitly narrowed.
    const root = newRoot()
    mkdirSync(root, { recursive: true })
    chmodSync(root, 0o755)

    selfHealCliEntry(root, '/opt/agentconnect/cli.js')
    expect(mode(root)).toBe(0o700)
  })

  it('stays best-effort when the root cannot be created', () => {
    // A pre-existing FILE where the root should be: the write fails, and the CLI must
    // still run — the pointer is a convenience for the daemon handoff, not a gate.
    const base = mkdtempSync(join(tmpdir(), 'ac-selfheal-'))
    const asFile = join(base, 'root')
    writeFileSync(asFile, 'not a directory')
    expect(() => selfHealCliEntry(asFile, '/opt/agentconnect/cli.js')).not.toThrow()
  })
})
