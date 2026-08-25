/**
 * Invocation routing (cli-daemon-split.md §4.2). The CLI reserves only its OWN
 * commands and delegates everything else — including unknown/future daemon
 * commands — so new daemon subcommands need no CLI release. Routing must be
 * transparent to global options placed before the command (commander accepted
 * `agentconnect --root /x chat`), so we find the first POSITIONAL token,
 * skipping global option values.
 */

/** Commands implemented by the CLI itself (everything else delegates). */
export const CLI_OWNED_COMMANDS = new Set([
  'up',
  'down',
  'restart',
  'status',
  'install',
  'install-service',
  'uninstall-service',
  'instances',
  'login',
  'version',
  'upgrade',
  'help'
])

/**
 * Global options that consume the following token as their value (so it is not
 * mistaken for the command). Boolean flags (--no-cp, --require-sandbox,
 * --dry-run, -h/--help, -V/--version) and the `--opt=value` form take no
 * separate token.
 */
const VALUE_OPTS = new Set([
  '--config',
  '--root',
  '--instance',
  '--api-url',
  '--api-key',
  '--daemon-id',
  '--log-level',
  '--agents-dir',
  '--max-agents',
  '--agent'
])

/**
 * Value-taking options of CLI-OWNED subcommands. They never precede the command,
 * so `firstPositional` has no use for them — but a scan that reaches past the
 * command (see {@link parseRootFlag}) must still know their values are values.
 * `--to` is the load-bearing one: the daemon passes a Control-Plane-supplied
 * version there, so a scan that reads it as an option would let that value steer
 * the CLI.
 */
const SUBCOMMAND_VALUE_OPTS = new Set(['--to', '--channel', '--keep'])

/** The first positional token (the subcommand), honoring option values and `--`. */
export function firstPositional(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === undefined) break
    if (a === '--') return argv[i + 1] // everything after `--` is positional
    if (a.startsWith('-')) {
      if (VALUE_OPTS.has(a)) i++ // its value is the next token — skip it
      continue // `--opt=value` and boolean flags consume no extra token
    }
    return a
  }
  return undefined
}

/**
 * The global `--root`, read before commander parses — the delegation/run paths
 * never build a program, and the cli-entry self-heal runs on every invocation.
 *
 * SECURITY: this walks the WHOLE argv (unlike {@link firstPositional}, `--root`
 * legitimately appears after the command), so it must skip option values or a
 * value would be read as a flag. The daemon spawns
 * `upgrade --to <CP-supplied version> --root <root>`; a naive scan would accept
 * `--to=--root=/elsewhere` and point every filesystem write below at that path.
 */
export function parseRootFlag(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === undefined) break
    if (a === '--') break // everything after `--` is positional, never our flag
    if (a === '--root') return argv[i + 1]
    if (a.startsWith('--root=')) return a.slice('--root='.length)
    // Any other value-taking option: its value is data, not a flag to inspect.
    if (VALUE_OPTS.has(a) || SUBCOMMAND_VALUE_OPTS.has(a)) i++
  }
  return undefined
}

/**
 * The global `--instance`, read with the same whole-argv scan as `--root`. It is
 * CLI-owned vocabulary (the daemon knows only roots), so `run`/delegate argv is
 * rewritten by {@link withResolvedRoot} before it reaches the daemon.
 */
export function parseInstanceFlag(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === undefined) break
    if (a === '--') break
    if (a === '--instance') return argv[i + 1]
    if (a.startsWith('--instance=')) return a.slice('--instance='.length)
    if (VALUE_OPTS.has(a) || SUBCOMMAND_VALUE_OPTS.has(a)) i++
  }
  return undefined
}

/**
 * Translate `--instance <name>` into the `--root <dir>` the daemon understands:
 * drop the instance tokens and append the resolved root unless one is already
 * spelled out. Only called when an instance was actually given, so an ordinary
 * invocation's argv reaches the daemon byte-for-byte as before.
 */
export function withResolvedRoot(argv: string[], root: string): string[] {
  const out: string[] = []
  let sawRoot = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === undefined) break
    if (a === '--') {
      out.push(...argv.slice(i)) // everything after `--` is data
      break
    }
    if (a === '--instance') {
      i++ // its value goes with it
      continue
    }
    if (a.startsWith('--instance=')) continue
    if (a === '--root' || a.startsWith('--root=')) sawRoot = true
    out.push(a)
    // Any other value-taking option: copy its value across untouched, so a value
    // that happens to read like a flag is never inspected as one.
    if ((VALUE_OPTS.has(a) || SUBCOMMAND_VALUE_OPTS.has(a)) && i + 1 < argv.length) out.push(argv[++i]!)
  }
  if (!sawRoot) out.push('--root', root)
  return out
}

export type Route = 'run' | 'delegate' | 'cli'

/**
 * Classify an invocation (argv after the node+script prefix):
 * - `run`      → the foreground respawn shell
 * - `delegate` → any daemon-owned or unknown command → exec the active daemon
 * - `cli`      → a CLI-owned command, or none (help/version/bare) → commander
 */
export function classifyInvocation(argv: string[]): Route {
  const cmd = firstPositional(argv)
  if (cmd === 'run') return 'run'
  if (cmd !== undefined && !CLI_OWNED_COMMANDS.has(cmd)) return 'delegate'
  return 'cli'
}
