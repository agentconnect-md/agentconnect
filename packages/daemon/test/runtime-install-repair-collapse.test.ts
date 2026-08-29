import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Agents on a non-isolated runtime share one npx tree, so their simultaneous start failures all
// plan the same repair. This file owns the module mock that lets two of them race in one process.
const repairRuntimeInstall = vi.fn()
vi.mock('../src/runtimes/runtime-install-repair.js', () => ({
  planRuntimeInstallRepair: (home: string) => ({ tree: join(home, '.npm', '_npx', 'shared'), pkg: 'pkg' }),
  repairRuntimeInstall: (...args: unknown[]) => repairRuntimeInstall(...args),
  npmRepairEnv: (home: string) => ({ HOME: home })
}))

const { Daemon } = await import('../src/daemon.js')

function scaffold(): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-collapse-'))
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      runtimes: { claude: { command: 'node', args: [] } }
    })
  )
  for (const id of ['bot-a', 'bot-b']) {
    const dir = join(root, 'agents', id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'agent.json'),
      JSON.stringify({
        id,
        name: id,
        status: 'active',
        runtime: 'claude',
        workspace: { mode: 'from-scratch', path: join(dir, 'workspace') },
        integrations: []
      })
    )
  }
  return root
}

describe('concurrent runtime install repair', () => {
  it('collapses two agents racing on one shared tree into a single reinstall', async () => {
    const root = scaffold()
    const daemon = new Daemon({ root, hostFactory: () => ({ start: async () => {}, stop: async () => {} }) as never })
    await daemon.start()
    const home = join(root, 'shared-home')
    let release: (value: boolean) => void = () => {}
    repairRuntimeInstall.mockImplementation(() => new Promise<boolean>((resolve) => (release = resolve)))

    const missing = new Error('Error: Missing optional dependency pkg')
    const first = (daemon as any).repairAgentRuntimeInstall('bot-a', home, missing)
    const second = (daemon as any).repairAgentRuntimeInstall('bot-b', home, missing)
    release(true)

    expect(await first).toBe('repaired')
    expect(await second).toBe('repaired')
    expect(repairRuntimeInstall).toHaveBeenCalledTimes(1)

    // The entry is released afterwards, so a later genuine break is repaired again.
    repairRuntimeInstall.mockResolvedValue(true)
    expect(await (daemon as any).repairAgentRuntimeInstall('bot-a', home, missing)).toBe('repaired')
    expect(repairRuntimeInstall).toHaveBeenCalledTimes(2)
    await daemon.stop()
  })
})
