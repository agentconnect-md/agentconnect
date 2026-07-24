/**
 * Command handlers for `agentconnect version …` + `upgrade` (cli-daemon-split.md
 * §5). Every mutating handler runs its whole transaction inside the version lock
 * (§5.5); `list` reads without locking. These are thin over the version-store /
 * install / upgrade modules and are what index.ts wires to commander.
 */
import { installTarget, resolveTarget } from './install.js'
import { realUpgradeDeps, upgrade } from './upgrade.js'
import { withVersionLock } from './version-lock.js'
import { pruneVersions, useVersion } from './version-ops.js'
import { currentVersion, listInstalled, readMeta, writeMeta, type Channel } from './version-store.js'

const note = (m: string): void => console.log(m)

export function versionList(root: string): void {
  const meta = readMeta(root)
  const installed = listInstalled(root)
  const cur = currentVersion(root)
  console.log(`channel: ${meta.channel}`)
  if (installed.length === 0) {
    console.log('installed: none — run `agentconnect install` (or `agentconnect run` to auto-install)')
    return
  }
  console.log('installed:')
  for (const v of installed) {
    const tags = [v === cur ? 'current' : '', v === meta.previous ? 'previous' : ''].filter(Boolean).join(', ')
    console.log(`  ${v}${tags ? `  (${tags})` : ''}`)
  }
}

export async function versionInstall(root: string, opts: { to?: string; channel?: Channel }): Promise<void> {
  await withVersionLock(root, 'install', async () => {
    const channel = opts.channel ?? readMeta(root).channel
    const target = await resolveTarget({ to: opts.to, channel })
    await installTarget(root, target, note)
    if (opts.channel) writeMeta(root, { ...readMeta(root), channel: opts.channel })
    // First install activates: with no `current` yet there is nothing to switch
    // away from, so the freshly installed version becomes active. This makes the
    // onboarding two-step (`version install` → `run`) work without a manual
    // `version use`. Subsequent installs stay non-switching (§5.1).
    if (!currentVersion(root)) {
      useVersion(root, target.version)
      note(`current → ${target.version}`)
    }
  })
}

export async function versionUse(root: string, version: string): Promise<void> {
  await withVersionLock(root, 'use', () => {
    useVersion(root, version)
    note(`current → ${version}`)
  })
}

export async function versionPrune(root: string, keep: number): Promise<void> {
  // `prune` waits for a concurrent writer rather than failing (§5.5).
  await withVersionLock(
    root,
    'prune',
    () => {
      const removed = pruneVersions(root, keep)
      note(removed.length ? `pruned ${removed.length}: ${removed.join(', ')}` : 'nothing to prune')
    },
    { wait: true }
  )
}

export async function runUpgrade(
  root: string,
  opts: { to?: string; channel?: Channel; restart?: boolean }
): Promise<void> {
  await withVersionLock(root, 'upgrade', () => upgrade(root, opts, realUpgradeDeps(root, note)), { wait: true })
}
