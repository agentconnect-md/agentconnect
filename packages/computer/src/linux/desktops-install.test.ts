import { describe, expect, it } from 'vitest'
import { installPlan, offerDesktopInstall, planText, type OfferDeps } from './desktops-install.js'
import type { DesktopSupport } from './desktops-support.js'

const has =
  (...names: string[]) =>
  (name: string): string | undefined =>
    names.includes(name) ? `/usr/bin/${name}` : undefined

const missing: DesktopSupport = {
  supported: false,
  reason: 'Xfce is not installed',
  fix: 'install xvfb dbus-x11 xfce4'
}
const apt = installPlan(has('apt-get'))!

function offer(support: DesktopSupport, deps: Partial<OfferDeps> = {}) {
  const lines: string[] = []
  const ran: string[][] = []
  const asked: string[] = []
  const result = offerDesktopInstall(support, {
    log: (line) => lines.push(line),
    interactive: true,
    asRoot: false,
    plan: apt,
    ask: async (question) => {
      asked.push(question)
      return true
    },
    run: (command) => {
      ran.push(command)
      return 0
    },
    probe: async () => ({ supported: true, session: 'xfce' }),
    ...deps
  })
  return { result, lines, ran, asked }
}

describe('installPlan', () => {
  it('uses the distribution package manager, without recommends or a display manager', () => {
    expect(apt.steps).toEqual([
      ['apt-get', 'update'],
      [
        'apt-get',
        'install',
        '-y',
        '--no-install-recommends',
        'xvfb',
        'dbus-x11',
        'xfce4-session',
        'xfwm4',
        'xfce4-panel',
        'xfdesktop4',
        'xfce4-settings',
        'xfconf'
      ]
    ])
    expect(installPlan(has('dnf'))?.steps[0]).toContain('--setopt=install_weak_deps=False')
    expect(installPlan(has('pacman'))?.steps[0]?.slice(0, 3)).toEqual(['pacman', '-S', '--needed'])
    expect(installPlan(has())).toBeUndefined()
  })

  it('prints the line with sudo unless already root', () => {
    expect(planText(apt, false)).toMatch(
      /^sudo apt-get update && sudo apt-get install -y --no-install-recommends xvfb /
    )
    expect(planText(apt, true)).toMatch(/^apt-get update && apt-get install /)
  })
})

describe('offerDesktopInstall', () => {
  it('asks once, installs with sudo, and probes again', async () => {
    const { result, ran, asked } = offer(missing)
    expect(await result).toEqual({ supported: true, session: 'xfce' })
    expect(asked).toEqual(['Install them now? [Y/n] '])
    expect(ran.map((command) => command.slice(0, 3))).toEqual([
      ['sudo', 'apt-get', 'update'],
      ['sudo', 'apt-get', 'install']
    ])
  })

  it('installs nothing when the answer is no, or without a terminal to ask on', async () => {
    const declined = offer(missing, { ask: async () => false })
    expect(await declined.result).toBe(missing)
    expect(declined.ran).toEqual([])
    const headless = offer(missing, { interactive: false })
    expect(await headless.result).toBe(missing)
    expect(headless.ran).toEqual([])
    expect(headless.lines.at(-1)).toMatch(/^Install them with: sudo apt-get update && /)
  })

  it('stops at a failing step', async () => {
    const ran: string[][] = []
    const { result } = offer(missing, {
      run: (command) => {
        ran.push(command)
        return 100
      }
    })
    expect(await result).toBe(missing)
    expect(ran).toEqual([['sudo', 'apt-get', 'update']])
  })

  it('offers nothing when packages are not the problem', async () => {
    const supported = offer({ supported: true, session: 'xfce' })
    expect(supported.asked).toEqual([])
    const broken = offer({ supported: false, reason: 'Xvfb exited (1)' })
    expect(await broken.result).toEqual({ supported: false, reason: 'Xvfb exited (1)' })
    expect(broken.asked).toEqual([])
  })
})
