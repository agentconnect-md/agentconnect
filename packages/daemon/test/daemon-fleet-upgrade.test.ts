import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Daemon } from '../src/daemon.js'

const roots: string[] = []

function scaffold(): string {
  const root = mkdtempSync(join(tmpdir(), 'agentconnect-fleet-upgrade-'))
  roots.push(root)
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      runtimes: { claude: { command: 'node', args: ['unused'] } }
    })
  )
  const cliEntry = join(root, 'agentconnect-cli.js')
  writeFileSync(cliEntry, '')
  writeFileSync(join(root, 'cli-entry'), `${cliEntry}\n`)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('daemon fleet upgrade coordination', () => {
  it('joins the same READY-delivered install when bootstrap auth reconnects', async () => {
    let finishInstall!: (installed: boolean) => void
    const blockedInstall = new Promise<boolean>((resolve) => (finishInstall = resolve))
    const upgradeInstaller = vi.fn(async () => await blockedInstall)
    const requestExit = vi.fn()
    const daemon = new Daemon({ root: scaffold(), supervisor: 'cli', upgradeInstaller, requestExit })
    ;(daemon as any).stop = vi.fn(async () => {})

    expect((daemon as any).fleetUpgrade.scheduleFleetExit('upgrade', '9.9.9')).toEqual({ accepted: true })
    await vi.waitFor(() => expect(upgradeInstaller).toHaveBeenCalledTimes(1))

    const reconnectOutcome = (daemon as any).fleetUpgrade.runBootstrapFleetUpgrade('9.9.9')
    finishInstall(true)

    const outcome = await reconnectOutcome
    expect(outcome.status).toBe('installed')
    expect(upgradeInstaller).toHaveBeenCalledTimes(1)
    outcome.restart()
    await vi.waitFor(() => expect(requestExit).toHaveBeenCalledTimes(1))
  })
})
