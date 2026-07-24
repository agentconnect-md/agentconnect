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
  '--cp-url',
  '--cp-key',
  '--daemon-id',
  '--log-level',
  '--agents-dir',
  '--max-agents',
  '--agent'
])

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
