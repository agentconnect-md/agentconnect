// `agentconnect computer …`: install, upgrade and diagnose the computer daemon from npm (computer-use.md §3.5); other commands pass through.
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Command } from 'commander'
import { withVersionLock } from '../version-lock.js'
import { DEFAULT_KEEP_VERSIONS } from '../version-ops.js'
import { currentVersion, listInstalled, readMeta, type Channel } from '../version-store.js'
import { currentLink, versionsDir, versionsJsonPath } from '../paths.js'
import {
  computerArgv,
  DESKTOP_BUNDLE,
  desktopDataDir,
  hostDefaults,
  resolveDesktopLaunch,
  type DesktopHost,
  type DesktopLaunch
} from './launch.js'
import { entryRunner, execComputer, type EntryRunner } from './run.js'
import { installComputer, realComputerOps, upgradeComputer, type ComputerTargetOpts } from './store.js'

// Subcommands the CLI implements; everything else (setup, register, run, pause, resume, token, service, …) goes to the daemon.
export const COMPUTER_OWNED_COMMANDS: ReadonlySet<string> = new Set([
  'install',
  'upgrade',
  'doctor',
  'status',
  'versions',
  'uninstall',
  'start',
  'stop',
  'restart'
])

const HELP_FLAGS = new Set(['-h', '--help', 'help'])

export interface ComputerContext {
  self: string
  host: DesktopHost
  root: string
  node: string
  run: EntryRunner
  log: (m: string) => void
}

export function computerContext(cli: string, host: DesktopHost = hostDefaults()): ComputerContext {
  const self = `${cli} computer`
  return {
    self,
    host,
    root: desktopDataDir(host),
    node: process.execPath,
    run: entryRunner(self),
    log: (m) => console.log(m)
  }
}

const launchFor = (ctx: ComputerContext, args: string[]): DesktopLaunch =>
  resolveDesktopLaunch(args, ctx.host, ctx.node, ctx.self)

const tryLaunch = (ctx: ComputerContext, args: string[]): DesktopLaunch | undefined => {
  try {
    return launchFor(ctx, args)
  } catch {
    return undefined
  }
}

const asChannel = (value?: string): Channel | undefined => {
  if (value === undefined || value === 'stable' || value === 'rc') return value
  throw new Error(`unknown channel '${value}' (use stable|rc)`)
}

const asKeep = (value?: string): number | undefined => {
  if (value === undefined) return undefined
  const keep = Number(value)
  if (!Number.isInteger(keep) || keep < 0) throw new Error(`invalid --keep '${value}' (use a whole number ≥ 0)`)
  return keep
}

const ensureRoot = (root: string): void => void mkdirSync(root, { recursive: true, mode: 0o700 })

interface TargetOptions {
  version?: string
  channel?: string
  keep?: string
}

interface InstallOptions extends TargetOptions {
  register?: string
  cpUrl?: string
  name?: string
  service?: boolean
  setup?: boolean
}

export function targetOpts(o: TargetOptions): ComputerTargetOpts {
  const channel = asChannel(o.channel)
  const keep = asKeep(o.keep)
  return {
    ...(o.version ? { version: o.version } : {}),
    ...(channel ? { channel } : {}),
    ...(keep !== undefined ? { keep } : {})
  }
}

// The setup arguments `install` forwards: registration, service choice, and any daemon option it does not know itself.
export function setupArgs(
  o: { register?: string; cpUrl?: string; name?: string; service?: boolean },
  extra: string[]
): string[] {
  return [
    'setup',
    ...(o.register ? ['--register', o.register] : []),
    ...(o.cpUrl ? ['--cp-url', o.cpUrl] : []),
    ...(o.name ? ['--name', o.name] : []),
    ...(o.service === false ? ['--no-service'] : []),
    ...extra
  ]
}

function printVersions(ctx: ComputerContext): void {
  const meta = readMeta(ctx.root)
  const installed = listInstalled(ctx.root)
  const cur = currentVersion(ctx.root)
  console.log(`channel: ${meta.channel}`)
  if (installed.length === 0) {
    console.log(`installed: none — run \`${ctx.self} install\``)
    return
  }
  console.log('installed:')
  for (const v of installed) {
    const tags = [v === cur ? 'current' : '', v === meta.previous ? 'previous' : ''].filter(Boolean).join(', ')
    console.log(`  ${v}${tags ? `  (${tags})` : ''}`)
  }
}

const describeLaunch = (launch: DesktopLaunch): string =>
  /\.(c|m)?js$/i.test(launch.args[0] ?? '') ? launch.args[0]! : launch.command

async function status(ctx: ComputerContext): Promise<void> {
  const cur = currentVersion(ctx.root)
  const launch = tryLaunch(ctx, ['service', 'status'])
  console.log(`data dir: ${ctx.root}`)
  console.log(
    `version:  ${cur ?? 'none from the version store'}${cur ? ` (channel ${readMeta(ctx.root).channel})` : ''}`
  )
  if (!launch) {
    console.log(`daemon:   not installed — run \`${ctx.self} install\``)
    return
  }
  console.log(`entry:    ${describeLaunch(launch)}`)
  const service = await ctx.run(launch, { capture: true, timeoutMs: 30_000 })
  let state = 'not available on this platform'
  try {
    const json = JSON.parse(service.stdout) as { installed?: boolean; loaded?: boolean; pid?: number; state?: string }
    state = !json.installed
      ? 'not installed'
      : `${json.loaded ? 'running' : 'stopped'}${json.pid ? ` (pid ${json.pid})` : ''}${json.state ? ` [${json.state}]` : ''}`
  } catch {
    // Windows has no service, only the Run key.
  }
  console.log(`service:  ${state}`)
  const answer = await ctx.run(launchFor(ctx, ['status']), { capture: true, timeoutMs: 10_000 })
  let daemon = 'not answering on its loopback controls'
  try {
    const json = JSON.parse(answer.stdout) as { version?: string; status?: string }
    if (answer.code === 0)
      daemon = `answering${json.version ? ` as ${json.version}` : ''}${json.status ? `, ${json.status}` : ''}`
  } catch {
    // An older daemon printed plain text, or none is running.
  }
  console.log(`daemon:   ${daemon}`)
}

// The legacy one-line installer's launcher (~/.local/bin/agentconnect-desktop), removed only when it runs this data dir's bundle.
function removeLegacyLauncher(root: string, log: (m: string) => void): void {
  if (process.platform === 'win32') return
  const launcher = join(homedir(), '.local', 'bin', 'agentconnect-desktop')
  try {
    if (readFileSync(launcher, 'utf8').includes(join(root, 'app', DESKTOP_BUNDLE))) {
      rmSync(launcher, { force: true })
      log(`removed ${launcher}`)
    }
  } catch {
    // none
  }
}

// Removes a symlink (or Windows junction) itself, never what it points at.
function removeLink(path: string): void {
  try {
    unlinkSync(path)
  } catch {
    rmSync(path, { recursive: true, force: true })
  }
}

export async function uninstall(ctx: ComputerContext, purge: boolean): Promise<void> {
  const off = ctx.host.platform === 'win32' ? ['autostart', 'disable'] : ['service', 'uninstall']
  const launch = tryLaunch(ctx, off)
  if (launch) {
    const result = await ctx.run(launch, { capture: true, timeoutMs: 120_000 })
    ctx.log(
      result.code === 0
        ? `removed the ${off[0]} entry`
        : `could not remove the ${off[0]} entry: ${result.stdout.trim()}`
    )
  }
  if (existsSync(ctx.root)) {
    await withVersionLock(
      ctx.root,
      'uninstall',
      () => {
        // The link goes first: once its versions are gone, a dangling link fails rmSync's existence check and stays.
        removeLink(currentLink(ctx.root))
        for (const path of [versionsDir(ctx.root), versionsJsonPath(ctx.root), join(ctx.root, 'app')])
          rmSync(path, { recursive: true, force: true })
      },
      { wait: true }
    )
  }
  removeLegacyLauncher(ctx.root, ctx.log)
  if (purge) {
    rmSync(ctx.root, { recursive: true, force: true })
    ctx.log(`removed ${ctx.root} (config, Computer key, audit log, Cua Driver, ffmpeg)`)
    ctx.log('The Computer stays listed in the console until you delete it there.')
  } else {
    ctx.log(`kept ${ctx.root} (config, Computer key, grants); \`${ctx.self} uninstall --purge\` removes it too`)
  }
}

function program(ctx: ComputerContext): Command {
  const fail = (cmd: string, err: unknown): never => {
    console.error(`${ctx.self} ${cmd}: ${(err as Error).message}`)
    process.exit(1)
  }
  const p = new Command(ctx.self)
    .description('Install, upgrade and diagnose the AgentConnect computer daemon (the desktop computer-use daemon)')
    .helpOption('-h, --help', 'show this help')
    .addHelpText(
      'after',
      `\nAny other command runs in the installed computer daemon: setup, register, run, pause, resume, token, service,\ninstall-driver, install-ffmpeg, … (\`${ctx.self} setup --help\` lists them). Data dir: ${ctx.root}`
    )
  const targetOptions = (c: Command): Command =>
    c
      .option('--version <version>', 'a specific version instead of the channel latest')
      .option('--channel <channel>', 'stable|rc (default: the stored channel, else the CLI’s own)')
      .option('--keep <n>', 'how many versions to keep afterwards (0 disables cleanup)', String(DEFAULT_KEEP_VERSIONS))

  targetOptions(
    p
      .command('install')
      .description(
        'Download and verify the computer daemon from npm, make it current, then run its setup (driver, grants, service)'
      )
      .option('--register <token>', 'the one-time registration token from the console (Computers → Add Computer)')
      .option('--cp-url <url>', 'the Control Plane to register with (the console prints it)')
      .option('--name <name>', 'the Computer name shown in the console (default: this host name)')
      .option('--no-service', 'do not install the background service')
      .option('--no-setup', 'only install the package; run setup later')
      .allowUnknownOption()
      .allowExcessArguments()
  ).action(async (o: InstallOptions, cmd: Command) => {
    try {
      ensureRoot(ctx.root)
      const ops = realComputerOps(ctx.root, { run: ctx.run, log: ctx.log })
      const target = targetOpts(o)
      await withVersionLock(ctx.root, 'install', () => installComputer(ctx.root, target, ops, ctx.self))
      if (o.setup === false) return void ctx.log(`installed; run \`${ctx.self} setup\` in the desktop session next`)
      const args = setupArgs(o, cmd.args)
      const result = await ctx.run(launchFor(ctx, args))
      process.exitCode = result.code
    } catch (err) {
      fail('install', err)
    }
  })

  targetOptions(
    p
      .command('upgrade')
      .description(
        'Install a newer version side by side, switch to it, restart the service and roll back if it is unhealthy'
      )
  ).action(async (o: TargetOptions) => {
    try {
      if (!currentVersion(ctx.root))
        throw new Error(`nothing installed in ${ctx.root} — run \`${ctx.self} install\` first`)
      const ops = realComputerOps(ctx.root, { run: ctx.run, log: ctx.log })
      const target = targetOpts(o)
      await withVersionLock(ctx.root, 'upgrade', () => upgradeComputer(ctx.root, target, ops, ctx.self), { wait: true })
    } catch (err) {
      fail('upgrade', err)
    }
  })

  // Listed for help; `doctor` runs through the pass-through path so every daemon option reaches it.
  p.command('doctor')
    .description('Run every check (inside the running service when there is one) and report the installed version')
    .option('--json', 'machine-readable checks')
    .allowUnknownOption()
  p.command('status')
    .description('Show the installed version, the service and whether the daemon answers')
    .action(() => status(ctx).catch((err) => fail('status', err)))
  p.command('versions')
    .description('List installed versions and the current one')
    .action(() => printVersions(ctx))
  p.command('uninstall')
    .description(
      'Remove the service, autostart entry and installed versions; --purge also removes config, key and data'
    )
    .option('--purge', 'also delete the data dir (registration key, config, audit log, downloaded tools)')
    .action((o: { purge?: boolean }) => uninstall(ctx, Boolean(o.purge)).catch((err) => fail('uninstall', err)))
  for (const action of ['start', 'stop', 'restart'] as const)
    p.command(action).description(`${action[0]!.toUpperCase()}${action.slice(1)} the background service`)
  return p
}

// `start`/`stop`/`restart` drive the daemon's own service command; Windows starts its Run-key entry instead.
export function serviceArgs(action: string, platform: NodeJS.Platform): string[] {
  return platform === 'win32' && action === 'start' ? ['autostart', 'start'] : ['service', action]
}

export async function runComputer(
  argv: string[],
  cli: string,
  ctx: ComputerContext = computerContext(cli)
): Promise<void> {
  const args = computerArgv(argv)
  const [first, ...rest] = args
  if (first === undefined || HELP_FLAGS.has(first)) return void program(ctx).outputHelp()
  if (first === 'doctor') {
    const launch = launchFor(ctx, args)
    if (!rest.includes('--json')) {
      const cur = currentVersion(ctx.root)
      console.log(
        `computer daemon: ${cur ? `${cur} (current)` : 'not from the version store'} — ${describeLaunch(launch)}\n`
      )
    }
    return execComputer(launch, ctx.self)
  }
  if (first === 'start' || first === 'stop' || first === 'restart')
    return execComputer(launchFor(ctx, [...serviceArgs(first, ctx.host.platform), ...rest]), ctx.self)
  if (!COMPUTER_OWNED_COMMANDS.has(first)) return execComputer(launchFor(ctx, args), ctx.self)
  await program(ctx).parseAsync(args, { from: 'user' })
}
