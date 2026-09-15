/** The polkit rule that lets the daemon's own account start/stop its system unit
 *  without sudo. Install writes it as root; uninstall removes exactly its own file. */
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { assertAccountName } from './account.js'

export const POLKIT_RULES_DIR = '/etc/polkit-1/rules.d'

/** Verbs the rule allows. `enable`/`disable` are deliberately absent — those are
 *  install/uninstall operations and stay root-only. */
export const POLKIT_VERBS = ['start', 'stop', 'restart', 'try-restart', 'reload-or-restart'] as const

/** `49-` sorts ahead of polkit's shipped `50-default.rules`, so this rule is consulted first. */
export function polkitRulePath(unitLabel: string, dir: string = POLKIT_RULES_DIR): string {
  return join(dir, `49-${unitLabel.replace(/\.service$/, '')}.rules`)
}

/** Narrow to one unit name, one account, and the lifecycle verbs — nothing else. */
export function buildPolkitRule(a: { unitLabel: string; user: string }): string {
  assertAccountName(a.user)
  const verbs = POLKIT_VERBS.map((v) => `'${v}'`).join(', ')
  return `// Installed by \`agentconnect install-service\` for unit ${a.unitLabel}.
// Removed by \`agentconnect uninstall-service\`. Scope: this unit, this account, these verbs.
polkit.addRule(function (action, subject) {
  if (
    action.id === 'org.freedesktop.systemd1.manage-units' &&
    action.lookup('unit') === '${a.unitLabel}' &&
    [${verbs}].indexOf(action.lookup('verb')) >= 0 &&
    subject.user === '${a.user}'
  ) {
    return polkit.Result.YES
  }
})
`
}

/** Does this host have the JS rules backend (polkit >= 0.106)? Older polkit reads
 *  `.pkla` files instead, and a rule dropped here would be silently ignored. */
export function polkitRulesSupported(dir: string = POLKIT_RULES_DIR): boolean {
  return existsSync(dir)
}

export function writePolkitRule(a: { unitLabel: string; user: string; dir?: string }): string {
  const path = polkitRulePath(a.unitLabel, a.dir ?? POLKIT_RULES_DIR)
  mkdirSync(a.dir ?? POLKIT_RULES_DIR, { recursive: true })
  writeFileSync(path, buildPolkitRule({ unitLabel: a.unitLabel, user: a.user }))
  // `writeFileSync`'s `mode` is masked by the umask, and polkitd runs as the
  // unprivileged `polkitd` user — under umask 077 the rule would land 0600 and
  // be silently unreadable, so the grant would never apply. chmod explicitly.
  chmodSync(path, 0o644)
  return path
}

export function removePolkitRule(unitLabel: string, dir: string = POLKIT_RULES_DIR): void {
  rmSync(polkitRulePath(unitLabel, dir), { force: true })
}
