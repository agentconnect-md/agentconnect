/** The sudoers grant that stands in for the polkit rule on hosts without polkit's
 *  rules.d backend: `sudo -n systemctl start|stop|restart <unit>` for one account. */
import { chmodSync, existsSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { assertAccountName } from './account.js'
import type { Exec } from './types.js'

export const SUDOERS_DIR = '/etc/sudoers.d'

/** Mirrors the polkit grant's lifecycle verbs; `enable`/`disable` stay root-only. */
export const SUDOERS_VERBS = ['start', 'stop', 'restart'] as const

/** sudo matches a rule against the exact path it runs, so both sides use this one. */
export function systemctlPath(exists: (p: string) => boolean = existsSync): string {
  return ['/usr/bin/systemctl', '/bin/systemctl'].find(exists) ?? '/usr/bin/systemctl'
}

/** sudo skips drop-ins whose name contains `.`, so `agentconnect@b.service` becomes `agentconnect-b`. */
export function sudoersRulePath(unitLabel: string, dir: string = SUDOERS_DIR): string {
  return join(dir, unitLabel.replace(/\.service$/, '').replace('@', '-'))
}

export function buildSudoersRule(a: { unitLabel: string; user: string; systemctl: string }): string {
  assertAccountName(a.user)
  const cmds = SUDOERS_VERBS.map((v) => `${a.systemctl} ${v} ${a.unitLabel}`).join(', ')
  return `# Installed by \`agentconnect install-service\` for unit ${a.unitLabel} (no polkit rules.d backend).
# Removed by \`agentconnect uninstall-service\`. Scope: this unit, this account, these verbs.
${a.user} ALL=(root) NOPASSWD: ${cmds}
`
}

/** Visudo-checks a staged copy before it goes live, since a broken drop-in breaks
 *  sudo for everyone; the `.tmp` name is one sudo ignores. Returns false when skipped. */
export async function writeSudoersRule(a: {
  unitLabel: string
  user: string
  exec: Exec
  dir?: string
  systemctl?: string
}): Promise<boolean> {
  const dir = a.dir ?? SUDOERS_DIR
  if (!existsSync(dir)) return false
  const path = sudoersRulePath(a.unitLabel, dir)
  const staged = `${path}.tmp`
  writeFileSync(
    staged,
    buildSudoersRule({ unitLabel: a.unitLabel, user: a.user, systemctl: a.systemctl ?? systemctlPath() })
  )
  chmodSync(staged, 0o440)
  const checked = await a.exec('visudo', ['-c', '-q', '-f', staged])
  if (checked.code !== 0) {
    rmSync(staged, { force: true })
    return false
  }
  renameSync(staged, path)
  return true
}

export function removeSudoersRule(unitLabel: string, dir: string = SUDOERS_DIR): void {
  rmSync(sudoersRulePath(unitLabel, dir), { force: true })
}
