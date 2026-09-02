import { describe, it, expect } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Daemon } from '../src/daemon.js'
import { MANAGED_RUNTIME_CATALOG } from '../src/runtimes/managed.js'
import { runtimePackageTree } from '../src/runtimes/runtime-store.js'
import type { ResolvedRuntimeCatalog } from '../src/runtimes/registry.js'
import type { NpxPackageLaunch, StoredRuntimePackage } from '../src/runtimes/runtime-store.js'

const RUNTIME = MANAGED_RUNTIME_CATALOG['codex-acp']!.runtime
const NAME = '@agentconnect.md/codex-acp'

type Probe = { runtimes: Record<string, { command: string; args: string[] }> }

function scaffold(agentRuntime?: string): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-store-daemon-'))
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
  const entry = { runtime: RUNTIME, source: 'managed' as const, name: 'Codex', version: '', skillsAgentId: null }
  return { entries: { 'codex-acp': entry }, runtimes: { 'codex-acp': RUNTIME } }
}

function daemonWith(root: string, ensure: (launch: NpxPackageLaunch) => Promise<StoredRuntimePackage>): Daemon {
  return new Daemon({
    root,
    resolveCatalog: async () => catalog(),
    installed: (runtimes) => runtimes,
    runtimeStore: { ensure }
  })
}

function refusal(daemon: Daemon): string {
  return (daemon as unknown as { runtimeUnavailableMessage(id: string): string }).runtimeUnavailableMessage('codex-acp')
}

function tree(root: string): { tree: string; bin: string } {
  const dir = runtimePackageTree(root, NAME, '1.4.2')
  return { tree: dir, bin: join(dir, 'node_modules', '@agentconnect.md', 'codex-acp', 'dist', 'index.js') }
}

describe('daemon-owned adapter store', () => {
  it('resolves and installs at start, and launches the tree rather than npx', async () => {
    const root = scaffold('codex-acp')
    const { tree: dir, bin } = tree(root)
    const seen: NpxPackageLaunch[] = []
    const daemon = daemonWith(root, async (launch) => {
      seen.push(launch)
      return { tree: dir, version: '1.4.2', bin }
    })
    await daemon.start()

    // One resolution for the whole daemon lifetime — a host spawn re-reads this def, never re-resolves.
    expect(seen).toHaveLength(1)
    expect(seen[0]!.name).toBe(NAME)
    const runtime = (daemon as unknown as Probe).runtimes['codex-acp']!
    expect(runtime.command).toBe(process.execPath)
    expect(runtime.args).toEqual([bin])
    expect([runtime.command, ...runtime.args].some((part) => part.includes('npx'))).toBe(false)
    await daemon.stop()
  })

  it('installs nothing at start for a runtime no agent uses, and localizes it once on first start', async () => {
    const root = scaffold()
    const { tree: dir, bin } = tree(root)
    let calls = 0
    const daemon = daemonWith(root, async () => {
      calls += 1
      return { tree: dir, version: '1.4.2', bin }
    })
    await daemon.start()
    expect(calls).toBe(0)
    expect((daemon as unknown as Probe).runtimes['codex-acp']!.command).toBe('npx')

    const localize = (daemon as unknown as { ensureRuntimeInstalled(id: string): Promise<void> }).ensureRuntimeInstalled
    await localize.call(daemon, 'codex-acp')
    await localize.call(daemon, 'codex-acp')
    expect(calls).toBe(1)
    expect((daemon as unknown as Probe).runtimes['codex-acp']!.args).toEqual([bin])
    await daemon.stop()
  })

  it('refuses to launch a runtime with no daemon-owned install, naming the tree', async () => {
    const root = scaffold('codex-acp')
    const { tree: dir } = tree(root)
    const daemon = daemonWith(root, async () => {
      throw new Error(`${NAME}@1.4.2 is not installed at ${dir}`)
    })
    await daemon.start()

    expect((daemon as unknown as { runtimes: Record<string, unknown> }).runtimes['codex-acp']).toBeUndefined()
    expect(refusal(daemon)).toContain('codex-acp@1.4.2')
    await daemon.stop()
  })

  it('keeps that refusal to one line with no absolute path, however the failure was thrown', async () => {
    const root = scaffold('codex-acp')
    const { tree: dir } = tree(root)
    // An ordinary Error carries a multi-line stack of absolute daemon paths; only its message may travel.
    const daemon = daemonWith(root, async () => {
      throw new Error(`${NAME}@1.4.2 is not installed at ${dir}`)
    })
    await daemon.start()

    const message = refusal(daemon)
    expect(message).not.toContain('\n')
    expect(message).not.toContain(root)
    expect(message).toContain('codex-acp@1.4.2')
    await daemon.stop()
  })
})
