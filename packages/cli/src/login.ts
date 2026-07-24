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
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { createInterface } from 'node:readline'
import { resolveRoot, configPath } from './paths.js'
import { CLI_VERSION } from './version.js'
import { probeAuth, type ProbeResult } from './cp/auth-probe.js'
import { resolveController, type InstallOpts } from './service/index.js'
import { runShell } from './run-shell.js'

export interface PersistCredsOpts {
  cpUrl: string
  cpKey: string
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

/** Merge url/token into config.json (validated), returning the written path. */
export function persistCredentials(opts: PersistCredsOpts): string {
  const root = resolveRoot(opts.root)
  const file = opts.configPath ?? configPath(root)
  const raw: Record<string, unknown> = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { version: 1 }

  const cp = (raw.controlPlane as Record<string, unknown> | undefined) ?? {}
  raw.controlPlane = { ...cp, url: opts.cpUrl, key: opts.cpKey, enabled: true }
  if (opts.daemonId) raw.daemonId = opts.daemonId

  assertValidControlPlane(raw) // fail before writing if the merge is invalid

  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(raw, null, 2) + '\n')
  return file
}

export interface RunLoginOpts {
  cpUrl?: string
  cpKey?: string
  daemonId?: string
  root?: string
  configPath?: string
}

/**
 * Build the InstallOpts for the OS service installer. Exported as a pure helper
 * so it can be unit-tested independently of the full `runLogin` orchestration.
 * The unit's daemon entry is always `<root>/current/dist/index.js`, so no entry
 * path is threaded here (§6).
 */
export function buildInstallOpts(opts: { root?: string }): InstallOpts {
  return {
    execPath: process.execPath,
    includeRootEnv: resolveRoot(opts.root) !== resolveRoot(undefined)
  }
}

/** Foreground args for the daemon `run`, threading through the resolved root and
 *  any CP overrides so the spawned daemon matches what login just configured. */
function foregroundArgv(opts: RunLoginOpts): string[] {
  const argv = ['run']
  if (opts.root) argv.push('--root', opts.root)
  if (opts.cpUrl) argv.push('--cp-url', opts.cpUrl)
  if (opts.cpKey) argv.push('--cp-key', opts.cpKey)
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
      const controller = resolveController({ root: opts.root })
      await controller.install(buildInstallOpts(opts))
      await controller.up()
    },
    // Foreground onboarding runs the daemon via the same respawn shell as
    // `agentconnect run` (§6.1) — it delegates to <root>/current and never
    // returns. Requires an installed daemon version (P2), or a manually seeded
    // `current` in P1.
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
    if (!opts.cpUrl) throw new Error('login requires --cp-url <url>')
    if (!opts.cpKey) throw new Error('login requires --cp-key <key>')
    const r = await deps.probe({ url: opts.cpUrl, token: opts.cpKey })
    if (!r.ok) throw new Error(`authentication failed: ${r.reason}`)
    persistCredentials({ ...opts, cpUrl: opts.cpUrl, cpKey: opts.cpKey })
    out.write(`✓ authenticated${r.daemonId ? ` (daemon ${r.daemonId})` : ''} — credentials saved\n`)
    return
  }

  // Both interactive handoffs read `<root>/config.json`: the installed service
  // runs `… run` (no `--config`), and the foreground daemon loads by root. A
  // custom `--config` would persist credentials the daemon never reads, so the
  // install/run branch would look successful but start without them. Reject it;
  // `--root` is the knob that keeps persist + service + foreground in sync.
  if (opts.configPath) {
    throw new Error(
      'interactive login does not support --config — use --root <dir> so the daemon and the installed service read the same config'
    )
  }

  // ── Interactive ──
  const rl = createInterface({ input: deps.input, output: out })
  const iter = rl[Symbol.asyncIterator]()
  let url = opts.cpUrl
  let token = opts.cpKey
  try {
    if (!url) url = await nextLine(iter, 'Control Plane URL: ', out)

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

    persistCredentials({ ...opts, cpUrl: url!, cpKey: token! })

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
