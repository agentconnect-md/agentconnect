/**
 * Interactive recovery for a foreground `run` whose daemon failed at startup
 * (cli-daemon-split.md §6.1). For a foreground run the respawn shell is the
 * supervisor and the operator is at the terminal — so when the daemon exits
 * nonzero shortly after spawn (broken bundle, bad upgrade) the CLI offers to
 * roll back to `previous`, force re-download the channel latest, or print the
 * manual version commands. Service mode, non-TTY, and dev-entry runs never
 * prompt: their exit code must propagate to the supervisor untouched.
 */
import { createInterface } from 'node:readline'
import type { ChildResult } from './delegate.js'
import { commandSelector } from './service/instance.js'
import { versionReinstallLatest, versionRollback } from './version-commands.js'
import { currentVersion, isInstalled, readMeta } from './version-store.js'

/**
 * Exits later than this after spawn are runtime crashes, not startup failures —
 * a version rollback would suggest the wrong fix, so recovery stays silent.
 */
export const STARTUP_FAILURE_WINDOW_MS = 60_000

export interface RecoveryContext {
  /** The service manager (or the user) asked us to stop — never prompt. */
  stopRequested: boolean
  /** AGENTCONNECT_SUPERVISOR=service: launchd/systemd supervises, no operator. */
  supervised: boolean
  /** AGENTCONNECT_DAEMON_ENTRY dev override: the version store is bypassed. */
  devEntry: boolean
  /** stdin AND stderr are TTYs — someone can actually answer the prompt. */
  interactive: boolean
  /** Milliseconds between spawn and exit. */
  elapsedMs: number
}

/** Pure predicate: does this daemon exit warrant the recovery prompt? */
export function shouldOfferRecovery(result: ChildResult, ctx: RecoveryContext): boolean {
  if (ctx.stopRequested || ctx.supervised || ctx.devEntry || !ctx.interactive) return false
  if (result.signal !== null) return false // killed, not failed
  if (!result.code) return false // clean exit
  return ctx.elapsedMs <= STARTUP_FAILURE_WINDOW_MS
}

export type RecoveryAction = 'rollback' | 'reinstall' | 'manual'

export interface RecoveryOption {
  key: string
  action: RecoveryAction
  label: string
}

/** The menu, keyed 1..n. Rollback is offered only when a usable `previous` exists. */
export function recoveryOptions(o: { previous: string | null; channel: string }): RecoveryOption[] {
  const options: RecoveryOption[] = []
  const add = (action: RecoveryAction, label: string): void => {
    options.push({ key: String(options.length + 1), action, label })
  }
  if (o.previous) add('rollback', `switch back to the previous version (${o.previous}) and retry`)
  add('reinstall', `re-download the latest ${o.channel} version and retry`)
  add('manual', 'show the commands to pick a version manually')
  return options
}

/** The manual-recovery commands, carrying the selector for the root being
 *  recovered so a paste does not act on the default instance instead. */
export function manualVersionHelp(root: string): string {
  const sel = commandSelector({ root })
  return [
    'Pick a daemon version manually:',
    `  agentconnect${sel} version list               # installed versions (current / previous)`,
    `  agentconnect${sel} version install <version>  # download a specific version`,
    `  agentconnect${sel} version use <version>      # activate it`,
    `  agentconnect${sel} run                        # start again`
  ].join('\n')
}

export interface RecoveryDeps {
  input: NodeJS.ReadableStream
  out: NodeJS.WritableStream
  rollback: (root: string) => Promise<string>
  reinstall: (root: string) => Promise<string>
  /**
   * Stop signal from the run shell (SIGTERM while the prompt or an action is
   * pending — there is no child to receive it). Aborting closes the prompt and
   * vetoes a pending action's respawn, so a stop is never followed by a launch.
   */
  signal?: AbortSignal
}

function realRecoveryDeps(): RecoveryDeps {
  return {
    input: process.stdin,
    // The prompt joins the daemon's own failure output on stderr; stdout stays
    // reserved for whatever the delegated command itself prints.
    out: process.stderr,
    rollback: versionRollback,
    reinstall: versionReinstallLatest
  }
}

/**
 * Show the menu and act on the choice. Resolves 'respawn' when a version switch
 * succeeded (the run shell re-resolves `current` and retries), 'exit' when the
 * user declined, asked for the manual commands, or a stop aborted the flow. A
 * failed action (registry down, previous pruned) re-offers the menu so the user
 * can pick another way out.
 */
export async function runRecoveryFlow(
  root: string,
  result: ChildResult,
  partial: Partial<RecoveryDeps> = {}
): Promise<'respawn' | 'exit'> {
  const deps: RecoveryDeps = { ...realRecoveryDeps(), ...partial }
  if (deps.signal?.aborted) return 'exit'
  const meta = readMeta(root)
  const cur = currentVersion(root)
  const previous = meta.previous && meta.previous !== cur && isInstalled(root, meta.previous) ? meta.previous : null
  const options = recoveryOptions({ previous, channel: meta.channel })

  deps.out.write(`agentconnect: daemon${cur ? ` ${cur}` : ''} exited with code ${result.code} during startup\n`)
  const rl = createInterface({ input: deps.input, output: deps.out })
  // Ctrl-C at the prompt and a stop signal both cancel: close the prompt AND
  // resolve `cancellation`, which races every awaited action below — a cancel
  // must finish this flow immediately even while an action is stuck waiting on
  // the version lock or inside a non-abortable registry fetch.
  let cancelled = false
  let markCancelled = (): void => {}
  const cancellation = new Promise<'cancelled'>((resolve) => {
    markCancelled = () => resolve('cancelled')
  })
  const cancel = (): void => {
    cancelled = true
    markCancelled()
    rl.close()
  }
  rl.on('SIGINT', cancel)
  deps.signal?.addEventListener('abort', cancel, { once: true })
  const iter = rl[Symbol.asyncIterator]()
  try {
    for (;;) {
      for (const o of options) deps.out.write(`  ${o.key}) ${o.label}\n`)
      deps.out.write(`Choose 1-${options.length}, or press Enter to exit: `)
      const { value, done } = await iter.next()
      if (cancelled) return 'exit'
      const answer = done ? '' : String(value).trim()
      if (answer === '') return 'exit'
      const choice = options.find((o) => o.key === answer)
      if (!choice) continue // unknown key — offer the menu again
      if (choice.action === 'manual') {
        deps.out.write(manualVersionHelp(root) + '\n')
        return 'exit'
      }
      // Settle-capture so the race below never leaves an unhandled rejection,
      // then race the action against cancellation. On cancel the orphaned
      // action keeps running only for the moments until the run shell exits —
      // the same interruption profile as Ctrl-C during a plain `version
      // install` (the tmp extract dir and a dead holder's version lock both
      // self-recover on the next run).
      const action = choice.action === 'rollback' ? deps.rollback : deps.reinstall
      const settled = action(root).then(
        (v) => ({ ok: true as const, v }),
        (err: unknown) => ({ ok: false as const, err })
      )
      const outcome = await Promise.race([settled, cancellation])
      if (outcome === 'cancelled' || cancelled) return 'exit' // stop wins — never respawn past it
      if (outcome.ok) {
        deps.out.write(`agentconnect: retrying with daemon ${outcome.v}…\n`)
        return 'respawn'
      }
      deps.out.write(`agentconnect: ${choice.action} failed: ${(outcome.err as Error).message}\n`)
      // fall through: the menu is offered again (e.g. registry down → roll back)
    }
  } finally {
    deps.signal?.removeEventListener('abort', cancel)
    rl.close()
  }
}
