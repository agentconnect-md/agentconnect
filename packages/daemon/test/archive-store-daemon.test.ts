import { describe, it, expect } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Daemon } from '../src/daemon.js'
import { runtimeArchiveTree, type ArchiveLaunch, type StoredRuntimeArchive } from '../src/runtimes/archive-store.js'
import type { ResolvedRuntimeCatalog } from '../src/runtimes/registry.js'

const ID = 'antigravity-acp'
const URL = 'https://dl.example.test/agy-acp-server-RC01-linux-x86_64.zip'
const RUNTIME = { command: './agy_acp_server.par', args: ['--uid='], env: [] }

type Probe = { runtimes: Record<string, { command: string; args: string[]; readRoots?: string[] }> }

function scaffold(agentRuntime?: string): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-archive-daemon-'))
  writeFileSync(join(root, 'config.json'), JSON.stringify({ version: 1, controlPlane: { enabled: false } }))
  if (!agentRuntime) return root
  const dir = join(root, 'agents', 'bot-a')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'agent.json'),
    JSON.stringify({
      id: 'bot-a',
      name: 'bot-a',
      status: 'active',
      runtime: agentRuntime,
      workspace: { mode: 'from-scratch', path: join(dir, 'workspace') },
      integrations: []
    })
  )
  return root
}

function catalog(): ResolvedRuntimeCatalog {
  const entry = {
    runtime: RUNTIME,
    source: 'registry' as const,
    name: 'Google Antigravity',
    version: '1.0.0',
    skillsAgentId: null,
    archive: URL
  }
  return { entries: { [ID]: entry }, runtimes: { [ID]: RUNTIME } }
}

function daemonWith(root: string, ensure: (launch: ArchiveLaunch) => Promise<StoredRuntimeArchive>): Daemon {
  return new Daemon({
    root,
    resolveCatalog: async () => catalog(),
    installed: (runtimes) => runtimes,
    archiveStore: { ensure }
  })
}

function installed(root: string): StoredRuntimeArchive {
  const tree = runtimeArchiveTree(root, ID, '1.0.0')
  return { tree, version: '1.0.0', bin: join(tree, 'agy_acp_server.par') }
}

describe('daemon-owned vendor archive store', () => {
  it('installs at start and launches the extracted binary, not the registry `./cmd`', async () => {
    const root = scaffold(ID)
    const stored = installed(root)
    const seen: ArchiveLaunch[] = []
    const daemon = daemonWith(root, async (launch) => {
      seen.push(launch)
      return stored
    })
    await daemon.start()

    // One install for the whole daemon lifetime — a host spawn re-reads this def, never re-fetches.
    expect(seen).toEqual([{ id: ID, url: URL, version: '1.0.0', bin: 'agy_acp_server.par', args: ['--uid='] }])
    const runtime = (daemon as unknown as Probe).runtimes[ID]!
    expect(runtime.command).toBe(stored.bin)
    expect(runtime.args).toEqual(['--uid='])
    // The outer sandbox denies the daemon root, so the store tree comes back as a read root.
    expect(runtime.readRoots).toEqual([stored.tree])
    await daemon.stop()
  })

  it('fetches nothing at start for a runtime no agent uses, and installs it once on first start', async () => {
    const root = scaffold()
    const stored = installed(root)
    let calls = 0
    const daemon = daemonWith(root, async () => {
      calls += 1
      return stored
    })
    await daemon.start()
    expect(calls).toBe(0)
    expect((daemon as unknown as Probe).runtimes[ID]!.command).toBe('./agy_acp_server.par')

    const localize = (daemon as unknown as { ensureRuntimeInstalled(id: string): Promise<void> }).ensureRuntimeInstalled
    await localize.call(daemon, ID)
    await localize.call(daemon, ID)
    expect(calls).toBe(1)
    expect((daemon as unknown as Probe).runtimes[ID]!.command).toBe(stored.bin)
    await daemon.stop()
  })

  it('refuses to launch when the archive install failed, in one path-free line', async () => {
    const root = scaffold(ID)
    const daemon = daemonWith(root, async () => {
      throw new Error(`archive for ${ID}@1.0.0 contains no "agy_acp_server.par"`)
    })
    await daemon.start()

    expect((daemon as unknown as Probe).runtimes[ID]).toBeUndefined()
    const message = (daemon as unknown as { runtimeUnavailableMessage(id: string): string }).runtimeUnavailableMessage(
      ID
    )
    expect(message).toContain(`${ID}@1.0.0`)
    expect(message).not.toContain('\n')
    expect(message).not.toContain(root)
    await daemon.stop()
  })
})
