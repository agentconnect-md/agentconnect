import { spawn } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { HelperTray, type HelperTrayOptions } from './tray-helper.js'

// A stand-in helper: answers each menu with the line its tooltip names (after a stray non-JSON line) and quits on EOF.
const FAKE = `
const rl = require('node:readline').createInterface({ input: process.stdin })
rl.on('line', (line) => {
  console.log('not json')
  console.log(JSON.parse(line).menu.tooltip)
})
rl.on('close', () => process.exit(0))
`

const startFake = (options: Omit<HelperTrayOptions, 'spawnHelper'>) =>
  HelperTray.start('fake', {
    ...options,
    spawnHelper: () => spawn(process.execPath, ['-e', FAKE], { stdio: ['pipe', 'pipe', 'inherit'] })
  })

const noop = { onClick: () => undefined, onMenuOpen: () => undefined, onRestart: () => undefined }

describe('tray helper', () => {
  it('sends each new menu as a line and turns the helper’s lines into clicks, menu opens and restarts', async () => {
    const events: string[] = []
    const tray = startFake({
      onClick: (id) => events.push(`click ${id}`),
      onMenuOpen: () => events.push('open'),
      onRestart: () => events.push('restart'),
      log: () => undefined
    })
    const menu = (tooltip: object) => ({ tone: 'online', tooltip: JSON.stringify(tooltip), items: [] })
    tray.update(menu({ action: 'click', id: 'stop' }))
    tray.update(menu({ action: 'click', id: 'stop' }))
    tray.update(menu({ action: 'menu-open' }))
    tray.update(menu({ action: 'click' }))
    tray.update(menu({ action: 'restart' }))
    await expect.poll(() => events).toEqual(['click stop', 'open', 'restart'])
    tray.close()
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(tray.problem).toBeUndefined()
  })

  it('reports a helper that cannot start or that exits', async () => {
    const logs: string[] = []
    const missing = HelperTray.start('/nonexistent/agentconnect-computer-menubar', {
      ...noop,
      log: (line) => logs.push(line)
    })
    await expect.poll(() => missing.problem).toContain('cannot start the menu bar helper')
    const crashed = HelperTray.start('fake', {
      ...noop,
      log: (line) => logs.push(line),
      spawnHelper: () => spawn(process.execPath, ['-e', 'process.exit(3)'], { stdio: ['pipe', 'pipe', 'inherit'] })
    })
    await expect.poll(() => crashed.problem).toBe('the menu bar helper exited (code 3)')
    crashed.update({ tone: 'online', tooltip: 'ready', items: [] })
    expect(logs).toHaveLength(2)
  })
})
