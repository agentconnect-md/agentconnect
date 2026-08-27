import { afterEach, beforeEach, describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { logsDir, daemonLogPath, daemonEntryForShims } from '../src/paths.js'

// The root under test is a POSIX absolute path, which resolves onto a drive on Windows.
describe.skipIf(process.platform === 'win32')('log paths', () => {
  it('logsDir is <root>/logs', () => {
    expect(logsDir('/tmp/ac')).toBe('/tmp/ac/logs')
  })
  it('daemonLogPath is <root>/logs/daemon.log', () => {
    expect(daemonLogPath('/tmp/ac')).toBe('/tmp/ac/logs/daemon.log')
  })
})

describe('daemonEntryForShims (cli-daemon-split §8)', () => {
  const prev = process.env.AGENTCONNECT_DAEMON_ENTRY
  beforeEach(() => {
    delete process.env.AGENTCONNECT_DAEMON_ENTRY
  })
  afterEach(() => {
    if (prev === undefined) delete process.env.AGENTCONNECT_DAEMON_ENTRY
    else process.env.AGENTCONNECT_DAEMON_ENTRY = prev
  })

  it('honors the AGENTCONNECT_DAEMON_ENTRY dev override above everything else', () => {
    process.env.AGENTCONNECT_DAEMON_ENTRY = '/dev/src/index.ts'
    expect(daemonEntryForShims('/no/such/root')).toBe('/dev/src/index.ts')
  })

  it('resolves <root>/current/dist/index.js when it exists (production)', () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-shim-'))
    const entry = join(root, 'current', 'dist', 'index.js')
    mkdirSync(join(root, 'current', 'dist'), { recursive: true })
    writeFileSync(entry, '// bundle')
    expect(daemonEntryForShims(root)).toBe(entry)
  })

  it('falls back to the running entry (argv[1]) when no version store exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-shim-'))
    expect(daemonEntryForShims(root)).toBe(process.argv[1])
  })
})
