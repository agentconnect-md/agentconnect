// Offers to install what per-agent desktops need with the distribution's package manager (computer-use.md §3.9).
import { spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { probeDesktopSupport, which, type DesktopSupport } from './desktops-support.js'

export interface InstallPlan {
  manager: 'apt' | 'dnf' | 'pacman'
  // Each step runs as root; a fresh apt cache comes first so the install finds the packages.
  steps: string[][]
}

// Xvfb, dbus-launch and the parts of Xfce a desktop runs, never a display manager or the distribution's recommends.
const PACKAGES = {
  apt: ['xvfb', 'dbus-x11', 'xfce4-session', 'xfwm4', 'xfce4-panel', 'xfdesktop4', 'xfce4-settings', 'xfconf'],
  dnf: [
    'xorg-x11-server-Xvfb',
    'dbus-x11',
    'xfce4-session',
    'xfwm4',
    'xfce4-panel',
    'xfdesktop',
    'xfce4-settings',
    'xfconf'
  ],
  pacman: ['xorg-server-xvfb', 'dbus', 'xfce4-session', 'xfwm4', 'xfce4-panel', 'xfdesktop', 'xfce4-settings', 'xfconf']
}

/** How this distribution installs the desktop packages, or undefined where no known package manager is found. */
export function installPlan(
  find: (name: string) => string | undefined = (name) => which(name)
): InstallPlan | undefined {
  if (find('apt-get')) {
    return {
      manager: 'apt',
      steps: [
        ['apt-get', 'update'],
        ['apt-get', 'install', '-y', '--no-install-recommends', ...PACKAGES.apt]
      ]
    }
  }
  if (find('dnf')) {
    return { manager: 'dnf', steps: [['dnf', 'install', '-y', '--setopt=install_weak_deps=False', ...PACKAGES.dnf]] }
  }
  if (find('pacman'))
    return { manager: 'pacman', steps: [['pacman', '-S', '--needed', '--noconfirm', ...PACKAGES.pacman]] }
  return undefined
}

/** The plan as one line a person can paste. */
export function planText(plan: InstallPlan, asRoot = process.getuid?.() === 0): string {
  return plan.steps.map((step) => (asRoot ? step : ['sudo', ...step]).join(' ')).join(' && ')
}

// Only a missing package is something installing can fix; an Xvfb that will not start is not.
export const installable = (support: DesktopSupport): boolean =>
  !support.supported && /is not installed$/.test(support.reason ?? '')

export interface OfferDeps {
  log: (line: string) => void
  interactive?: boolean
  ask?: (question: string) => Promise<boolean>
  run?: (command: string[]) => number
  plan?: InstallPlan | undefined
  probe?: () => Promise<DesktopSupport>
  asRoot?: boolean
}

export async function askYes(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await new Promise<string>((resolve) => rl.question(question, resolve))
    return !/^n/i.test(answer.trim())
  } finally {
    rl.close()
  }
}

export function runInherited(command: string[]): number {
  return spawnSync(command[0]!, command.slice(1), { stdio: 'inherit' }).status ?? 1
}

/** When the switch is on and only packages are missing, asks once and installs them; returns what this machine now supports. */
export async function offerDesktopInstall(support: DesktopSupport, deps: OfferDeps): Promise<DesktopSupport> {
  if (!installable(support)) return support
  const plan = 'plan' in deps ? deps.plan : installPlan()
  const log = deps.log
  log(`Per-agent desktops need packages that are missing here (${support.reason}).`)
  if (!plan) {
    log('No apt, dnf or pacman found: install Xvfb, dbus-launch and Xfce (xfce4-session, xfwm4) yourself.')
    return support
  }
  const asRoot = deps.asRoot ?? process.getuid?.() === 0
  const line = planText(plan, asRoot)
  if (!(deps.interactive ?? (process.stdin.isTTY && process.stdout.isTTY))) {
    log(`Install them with: ${line}`)
    return support
  }
  log('They give each agent its own desktop (no display manager is installed, your login stays as it is):')
  log(`  ${line}`)
  if (!(await (deps.ask ?? askYes)('Install them now? [Y/n] '))) {
    log('Skipped: agents take turns on this desktop until the packages are installed.')
    return support
  }
  const run = deps.run ?? runInherited
  for (const step of plan.steps) {
    const status = run(asRoot ? step : ['sudo', ...step])
    if (status !== 0) {
      log(`"${step.join(' ')}" failed (exit ${status}); per-agent desktops stay unavailable.`)
      return support
    }
  }
  const after = await (deps.probe ?? (() => probeDesktopSupport()))()
  log(after.supported ? 'Installed: each agent now gets its own desktop.' : `Still unavailable: ${after.reason}`)
  return after
}
