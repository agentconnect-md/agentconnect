/**
 * `agentconnect login` — interactive onboarding. It tests the Control Plane auth
 * flow, persists credentials only on success, then offers to install the OS
 * service. If installed it starts the service (`up`) and returns; otherwise it
 * runs the daemon in the foreground (the same path as `agentconnect run`, i.e.
 * the respawn shell over `<root>/current`).
 *
 * `persistCredentials` is the pure config-merge half (token-only onboarding:
 * `daemonId` is omitted unless given — the first connect adopts it from the
 * token's `sub`). `runLogin` is the orchestrator, with injectable deps for tests.
 */
import { chmodSync, readFileSync, existsSync, writeFileSync, mkdirSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { createInterface } from 'node:readline'
import { resolveRoot, configPath } from './paths.js'
import { CLI_VERSION } from './version.js'
import { probeAuth, type ProbeResult } from './cp/auth-probe.js'
import { installService as installUnit, shouldBakeRootEnv, type InstallOpts } from './service/index.js'
import { ensureDaemonInstalled, runShell } from './run-shell.js'

export interface PersistCredsOpts {
  apiUrl: string
  apiKey: string
  daemonId?: string
  root?: string
  configPath?: string
}

/**
 * Minimal shape check before writing config.json. The CLI deliberately does NOT
 * import the daemon's full ConfigSchema (that would couple it to the daemon
 * package); the daemon still fully validates on boot (cli-daemon-split.md §4.1,
 * open decision). We only guard the fields login writes.
 */
function assertValidControlPlane(raw: Record<string, unknown>): void {
  const cp = raw.controlPlane as Record<string, unknown> | undefined
  if (!cp || typeof cp.url !== 'string' || cp.url.length === 0) {
    throw new Error('invalid config: controlPlane.url must be a non-empty string')
  }
  if (typeof cp.key !== 'string' || cp.key.length === 0) {
    throw new Error('invalid config: controlPlane.key must be a non-empty string')
  }
  if (raw.daemonId !== undefined && typeof raw.daemonId !== 'string') {
    throw new Error('invalid config: daemonId must be a string')
  }
}

function protectCredentialsFile(file: string): void {
  if (!existsSync(file)) return
  try {
    if ((statSync(file).mode & 0o777) !== 0o600) chmodSync(file, 0o600)
  } catch (err) {
    // A login must never put a fresh key into a broadly readable file. Windows
    // does not provide enforceable POSIX mode semantics, so retain its existing
    // best-effort behavior.
    if (process.platform !== 'win32') throw err
  }
}

function writeCredentialsFile(file: string, raw: Record<string, unknown>): void {
  // `mode` protects a new credential file; chmod-before-write repairs an
  // existing config before fresh secrets reach it. Leave a custom parent alone.
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  protectCredentialsFile(file)
  writeFileSync(file, JSON.stringify(raw, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  protectCredentialsFile(file)
}

/** Merge url/token into config.json (validated), returning the written path. */
export function persistCredentials(opts: PersistCredsOpts): string {
  const root = resolveRoot(opts.root)
  const file = opts.configPath ?? configPath(root)
  protectCredentialsFile(file)
  const raw: Record<string, unknown> = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { version: 1 }

  const cp = (raw.controlPlane as Record<string, unknown> | undefined) ?? {}
  raw.controlPlane = { ...cp, url: opts.apiUrl, key: opts.apiKey, enabled: true }
  if (opts.daemonId) raw.daemonId = opts.daemonId

  assertValidControlPlane(raw) // fail before writing if the merge is invalid

  writeCredentialsFile(file, raw)
  return file
}

export interface RunLoginOpts {
  apiUrl?: string
  apiKey?: string
  daemonId?: string
  root?: string
  /** Named service instance to install as (service/instance.ts). */
  instance?: string
  configPath?: string
  /** This CLI's own dist entry, pinned into the service unit (InstallOpts.cliEntry). */
  cliEntry?: string
}

/**
 * Build the InstallOpts for the OS service installer. Exported as a pure helper
 * so it can be unit-tested independently of the full `runLogin` orchestration.
 * The unit's daemon entry is always `<root>/current/dist/index.js`, so no entry
 * path is threaded here (§6).
 */
export function buildInstallOpts(opts: { root?: string; cliEntry?: string }): InstallOpts {
  return {
    execPath: process.execPath,
    // Follows the RESOLVED root, so an AGENTCONNECT_ROOT-driven login cannot
    // write a unit that omits the root and starts on ~/.agentconnect instead.
    includeRootEnv: shouldBakeRootEnv(resolveRoot(opts.root)),
    ...(opts.cliEntry ? { cliEntry: opts.cliEntry } : {}),
    ...(process.env.PATH ? { envPath: process.env.PATH } : {})
  }
}

/** Foreground args for the daemon `run`, threading through the resolved root and
 *  any API overrides so the spawned daemon matches what login just configured. */
function foregroundArgv(opts: RunLoginOpts): string[] {
  const argv = ['run']
  if (opts.root) argv.push('--root', opts.root)
  if (opts.apiUrl) argv.push('--api-url', opts.apiUrl)
  if (opts.apiKey) argv.push('--api-key', opts.apiKey)
  if (opts.daemonId) argv.push('--daemon-id', opts.daemonId)
  return argv
}

export interface LoginDeps {
  probe: (o: { url: string; token: string }) => Promise<ProbeResult>
  installService: () => Promise<void>
  runForeground: () => Promise<void>
  out: NodeJS.WritableStream
  input: NodeJS.ReadableStream
  isTTY: boolean
}

function realDeps(opts: RunLoginOpts): LoginDeps {
  return {
    probe: (o) => probeAuth({ url: o.url, token: o.token, agentVersion: CLI_VERSION }),
    installService: async () => {
      const root = resolveRoot(opts.root)
      await ensureDaemonInstalled(root)
      const controller = await installUnit(
        { root, ...(opts.instance !== undefined ? { instance: opts.instance } : {}) },
        buildInstallOpts(opts)
      )
      await controller.up()
    },
    // Foreground onboarding runs the daemon via the same respawn shell as
    // `agentconnect run` (§6.1) — it delegates to <root>/current and never
    // returns. The shell bootstraps the selected daemon channel when `current`
    // does not exist yet.
    runForeground: () => runShell(resolveRoot(opts.root), foregroundArgv(opts)),
    out: process.stdout,
    input: process.stdin,
    isTTY: Boolean(process.stdin.isTTY)
  }
}

/** Read the next line from a readline interface via async iterator. */
async function nextLine(
  iter: AsyncIterableIterator<string>,
  prompt: string,
  out: NodeJS.WritableStream
): Promise<string> {
  out.write(prompt)
  const { value, done } = await iter.next()
  if (done) throw new Error(`unexpected end of input waiting for: ${prompt}`)
  return (value as string).trim()
}

export async function runLogin(opts: RunLoginOpts, partial: Partial<LoginDeps> = {}): Promise<void> {
  const deps: LoginDeps = { ...realDeps(opts), ...partial }
  const { out } = deps

  // ── Non-interactive: flags required; probe; persist. No prompts, no handoff. ──
  if (!deps.isTTY) {
    if (!opts.apiUrl) throw new Error('login requires --api-url <url>')
    if (!opts.apiKey) throw new Error('login requires --api-key <key>')
    const r = await deps.probe({ url: opts.apiUrl, token: opts.apiKey })
    if (!r.ok) throw new Error(`authentication failed: ${r.reason}`)
    persistCredentials({ ...opts, apiUrl: opts.apiUrl, apiKey: opts.apiKey })
    out.write(`✓ authenticated${r.daemonId ? ` (daemon ${r.daemonId})` : ''} — credentials saved\n`)
    return
  }

  // Both interactive handoffs read `<root>/config.json`: the installed service
  // runs `… run` (no `--config`), and the foreground daemon loads by root. A
  // custom `--config` would persist credentials the daemon never reads, so the
  // install/run branch would look successful but start without them. Reject it;
  // `--root`/`--instance` are the knobs that keep persist + service + foreground
  // in sync.
  if (opts.configPath) {
    throw new Error(
      'interactive login does not support --config — use --root <dir> (or --instance <name>) so the daemon and the installed service read the same config'
    )
  }

  // ── Interactive ──
  const rl = createInterface({ input: deps.input, output: out })
  const iter = rl[Symbol.asyncIterator]()
  let url = opts.apiUrl
  let token = opts.apiKey
  try {
    if (!url) url = await nextLine(iter, 'AgentConnect API URL: ', out)

    for (let attempt = 0; ; attempt++) {
      if (!token) token = await nextLine(iter, 'Daemon API key: ', out)
      out.write(`Testing connection to ${url}…\n`)
      const r = await deps.probe({ url: url!, token: token! })
      if (r.ok) {
        out.write(`✓ authenticated${r.daemonId ? ` (daemon ${r.daemonId})` : ''}\n`)
        break
      }
      out.write(`✗ ${r.reason}\n`)
      if (attempt >= 1) throw new Error('authentication failed')
      token = undefined // re-prompt on retry
    }

    persistCredentials({ ...opts, apiUrl: url!, apiKey: token! })

    const ans = (await nextLine(iter, 'Install AgentConnect as a background service? (y/N) ', out)).toLowerCase()
    if (ans === 'y' || ans === 'yes') {
      await deps.installService()
      out.write('Service installed and started. Manage it with `agentconnect up` / `down` / `status`.\n')
      return
    }
    out.write('Starting in the foreground (Ctrl-C to stop)…\n')
  } finally {
    rl.close()
  }

  await deps.runForeground()
}
