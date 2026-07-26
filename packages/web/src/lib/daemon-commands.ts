/**
 * Translate the Control-Plane-minted onboarding command into the unified-CLI
 * (`@agentconnect.md/cli`) commands the console shows.
 *
 * The CP mints `npx -y @agentconnect.md/daemon[@<tag>] run --api-url … --api-key …`
 * (`onboarding.ts`), where `<tag>` is the pinned daemon dist-tag/version
 * (`DAEMON_DIST_TAG`, e.g. `rc` on a test CP). The CLI's first run automatically
 * installs and activates its release channel, so onboarding needs only one
 * run/login command.
 *
 * The **CLI** release channel goes on the npx package spec
 * (`@agentconnect.md/cli@rc`). The CLI is published to npm on the SAME
 * `rc`/`latest` dist-tags as the daemon (`scripts/publish-cli-if-changed.sh`),
 * so an rc environment must pull the rc CLI and therefore bootstrap an rc
 * daemon. Exact daemon versions cannot be applied to the independently
 * versioned CLI package, so their single command retains an explicit install
 * prefix before run/login.
 */
const DAEMON_PKG = '@agentconnect.md/daemon'
const CLI_PKG = '@agentconnect.md/cli'

/** Parse `npx -y @agentconnect.md/daemon[@<tag>] <rest…>` into its pinned daemon
 *  tag (if any) and the remainder (`run --api-url … --api-key …`). Returns null if
 *  the command isn't in the expected shape (defensive — callers fall back). */
function parse(command: string): { tag?: string; rest: string } | null {
  const esc = DAEMON_PKG.replace(/[.]/g, '\\.')
  const m = command.match(new RegExp(`^npx\\s+-y\\s+${esc}(?:@(\\S+))?\\s+(.*)$`))
  if (!m) return null
  return { tag: m[1], rest: m[2] ?? '' }
}

export interface DaemonCommands {
  /** `npx -y @agentconnect.md/cli[@rc] run …` — foreground. */
  run: string
  /** `npx -y @agentconnect.md/cli[@rc] login …` — probe + save creds + install service. */
  login: string
}

/** Build the single-step run/login CLI commands from the CP's minted command. */
export function daemonCommands(command: string): DaemonCommands {
  const parsed = parse(command)
  // Fall back to a name-only rewrite if the shape is unexpected, so we never show
  // a broken command; the pinned-version paths just degrade to the default channel.
  const rest = parsed?.rest ?? command.replace(new RegExp(`\\b${DAEMON_PKG.replace(/[.]/g, '\\.')}(@\\S+)?`), 'run')
  const tag = parsed?.tag
  const cli = cliPkgSpec(tag)
  const run = `npx -y ${cli} ${rest}`
  const login = `npx -y ${cli} ${rest.replace(/^run\b/, 'login')}`
  const install = exactInstallPrefix(cli, tag)

  return {
    run: install ? `${install} && ${run}` : run,
    login: install ? `${install} && ${login}` : login
  }
}

/** Pin the CLI package to the daemon tag's release CHANNEL so it contains
 *  channel-matched behavior. Only `rc` needs an explicit pin; `stable`/absent and
 *  exact daemon versions resolve the CLI from `latest` (never pin the CLI to a
 *  daemon version — independent publishes). */
function cliPkgSpec(tag?: string): string {
  return tag === 'rc' ? `${CLI_PKG}@rc` : CLI_PKG
}

/** Stable/rc are inferred by the selected CLI channel. An exact daemon version
 *  still needs one explicit install before the connect command. */
function exactInstallPrefix(cli: string, tag?: string): string | null {
  if (!tag || tag === 'stable' || tag === 'rc') return null
  return `npx -y ${cli} install ${tag}`
}
