import { spawn } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { HelperTray, type HelperTrayOptions } from './tray-helper.js'

// A stand-in helper: answers each state with an action line (after a stray non-JSON line for busy) and quits on stdin EOF.
const FAKE = `
const rl = require('node:readline').createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const { state } = JSON.parse(line)
  if (state.tone === 'busy') console.log('not json')
  const action = state.tone === 'unavailable' ? 'restart' : state.canStop ? 'stop' : 'resume'
  console.log(JSON.stringify({ action }))
})
rl.on('close', () => process.exit(0))
`

const startFake = (options: Omit<HelperTrayOptions, 'spawnHelper'>) =>
  HelperTray.start('fake', {
    ...options,
    spawnHelper: () => spawn(process.execPath, ['-e', FAKE], { stdio: ['pipe', 'pipe', 'inherit'] })
  })

describe('tray helper', () => {
  it('sends each new state as a line and turns the helper’s lines into Stop, Resume and Restart', async () => {
    const actions: string[] = []
    const tray = startFake({
      onStop: () => actions.push('stop'),
      onResume: () => actions.push('resume'),
      onRestart: () => actions.push('restart'),
      log: () => undefined
    })
    const online = { tone: 'online' as const, status: 'ready', canStop: true, canResume: false }
    tray.update(online)
    tray.update(online)
    tray.update({ tone: 'busy', status: 'controlled by claude', canStop: false, canResume: true })
    tray.update({ tone: 'unavailable', status: 'unavailable', canStop: true, canResume: false })
    await expect.poll(() => actions).toEqual(['stop', 'resume', 'restart'])
    tray.close()
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(tray.problem).toBeUndefined()
  })

  it('reports a helper that cannot start or that exits', async () => {
    const logs: string[] = []
    const missing = HelperTray.start('/nonexistent/agentconnect-computer-menubar', {
      onStop: () => undefined,
      onResume: () => undefined,
      onRestart: () => undefined,
      log: (line) => logs.push(line)
    })
    await expect.poll(() => missing.problem).toContain('cannot start the menu bar helper')
    const crashed = HelperTray.start('fake', {
      onStop: () => undefined,
      onResume: () => undefined,
      onRestart: () => undefined,
      log: (line) => logs.push(line),
      spawnHelper: () => spawn(process.execPath, ['-e', 'process.exit(3)'], { stdio: ['pipe', 'pipe', 'inherit'] })
    })
    await expect.poll(() => crashed.problem).toBe('the menu bar helper exited (code 3)')
    crashed.update({ tone: 'online', status: 'ready', canStop: true, canResume: false })
    expect(logs).toHaveLength(2)
  })
})
