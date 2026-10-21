import { describe, expect, it, vi } from 'vitest'
import {
  autostartEntry,
  EXIT_NEW_SESSION,
  inGraphicalSession,
  SESSION_ENV,
  UNIT,
  unitFile,
  watchSession,
  type SessionProbe
} from './service-linux.js'

function probe(
  live: Record<string, boolean>,
  manager: string | undefined,
  graphical = true
): SessionProbe & { forgotten: string[] } {
  const forgotten: string[] = []
  return {
    forgotten,
    graphical: async () => graphical,
    live: async (id) => live[id] ?? false,
    managerSession: async () => manager,
    forget: async (id) => void forgotten.push(id)
  }
}

async function ended(p: SessionProbe): Promise<{ code: number; reason: string } | undefined> {
  vi.useFakeTimers()
  try {
    let result: { code: number; reason: string } | undefined
    const stop = watchSession({
      session: '7',
      probe: p,
      intervalMs: 1000,
      onEnded: (code, reason) => (result = { code, reason }),
      onIgnored: (reason) => (result = { code: -1, reason })
    })
    await vi.advanceTimersByTimeAsync(3000)
    stop()
    return result
  } finally {
    vi.useRealTimers()
  }
}

describe('Linux service', () => {
  it('runs the pinned runtime on the stable bundle, skips without a display and restarts only on failure', () => {
    const unit = unitFile('/home/u/.agentconnect/desktop/runtime/node/bin/node', '/home/u/app/agentconnect-desktop.mjs')
    expect(unit).toContain(
      'ExecStart="/home/u/.agentconnect/desktop/runtime/node/bin/node" "/home/u/app/agentconnect-desktop.mjs" run'
    )
    expect(unit).toContain(`ExecCondition=/bin/sh -c 'test -n "$DISPLAY$WAYLAND_DISPLAY"'`)
    expect(unit).toContain('Restart=on-failure')
    expect(unit).toContain('PartOf=graphical-session.target')
    expect(unit).toContain('WantedBy=graphical-session.target')
  })

  it('autostarts by importing the session, naming it, clearing an old start limit, then starting', () => {
    const exec = /^Exec=sh -c '(.*)'$/m.exec(autostartEntry())![1]!.split('; ')
    expect(exec[0]).toMatch(/^systemctl --user import-environment DISPLAY XAUTHORITY WAYLAND_DISPLAY /)
    expect(exec.slice(1)).toEqual([
      `systemctl --user set-environment ${SESSION_ENV}=$XDG_SESSION_ID`,
      `systemctl --user reset-failed ${UNIT}`,
      `systemctl --user start ${UNIT}`
    ])
  })

  it('tells a graphical session from SSH', () => {
    expect(inGraphicalSession({ DISPLAY: ':0' })).toBe(true)
    expect(inGraphicalSession({ WAYLAND_DISPLAY: 'wayland-0' })).toBe(true)
    expect(inGraphicalSession({ SSH_CONNECTION: '1 2 3 4' })).toBe(false)
  })

  it('keeps running while its session is open', async () => {
    expect(await ended(probe({ '7': true }, '7'))).toBeUndefined()
  })

  it('exits cleanly and forgets the display when its session ends', async () => {
    const p = probe({}, '7')
    expect(await ended(p)).toEqual({ code: 0, reason: 'desktop session 7 ended' })
    expect(p.forgotten).toEqual(['7'])
  })

  it('restarts into the next session when the user already logged in again', async () => {
    const p = probe({ '9': true }, '9')
    expect(await ended(p)).toEqual({
      code: EXIT_NEW_SESSION,
      reason: 'desktop session 7 ended; restarting in session 9'
    })
    expect(p.forgotten).toEqual([])
  })

  it('ignores a session that is not graphical, such as the SSH login setup ran from', async () => {
    const p = probe({}, '7', false)
    expect(await ended(p)).toEqual({ code: -1, reason: 'session 7 is not a graphical session; not following it' })
    expect(p.forgotten).toEqual([])
  })

  it('does not follow a newer session that has ended too', async () => {
    const p = probe({}, '9')
    expect((await ended(p))?.code).toBe(0)
  })
})
