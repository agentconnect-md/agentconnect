/**
 * Game subjects — who plays (docs/designs/collaboration-arena.md §8.1/§14).
 *
 * `scripted` is the reproducible engine gate: deterministic in-process ACP
 * hosts, no credentials. `real` runs the IDENTICAL game against the operator's
 * subject template (real runtimes, real provider credentials): each compiled
 * game agent is materialized from a template agent with the compiled UUID
 * identity, memory off, and NO on-disk integrations — the evaluation
 * environment (§5) stays the only integration authority. Any difference
 * between the two is behavioral, not engine uncertainty.
 */
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { collectObjectSecrets, environmentSecrets } from '../../packages/daemon/src/evaluation/index.js'
import type { CompiledTopology } from './types.js'

export type GameSubjectSpec =
  | { kind: 'scripted' }
  | {
      kind: 'real'
      /** Template root: config.json (with explicit runtimes) + agents/<id>/agent.json. */
      subjectRoot: string
      /** Template agent ids mapped onto the game's agent aliases IN ORDER.
       *  One id may be repeated to clone a single template into every seat;
       *  a single-element list is broadcast. */
      templateAgentIds: string[]
    }

export interface PreparedGameSubject {
  root: string
  /** Values that must never reach an artifact: template credentials plus
   *  secret-shaped process environment values. The runner feeds these into
   *  every collector/writer redaction set. */
  secrets: string[]
  cleanup(): void
}

function assertNotSymlink(path: string, label: string): void {
  if (lstatSync(path).isSymbolicLink()) throw new Error(`${label} may not be a symbolic link`)
}

function assertNoSymlinks(path: string, label: string): void {
  assertNotSymlink(path, label)
  if (!lstatSync(path).isDirectory()) return
  for (const entry of readdirSync(path)) assertNoSymlinks(join(path, entry), label)
}

/** Disposable scripted subject: one scripted-runtime agent per compiled agent id.
 *  Integrations stay EMPTY on disk — the evaluation environment (§5) is the only
 *  authority that projects the virtual integrations in. */
export function prepareScriptedSubject(topology: CompiledTopology): PreparedGameSubject {
  const root = mkdtempSync(join(tmpdir(), 'ac-arena-'))
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      runtimes: { scripted: { command: 'node', args: ['unused'] } }
    })
  )
  for (const agent of topology.agents) {
    const agentDir = join(root, 'agents', agent.agentId)
    mkdirSync(agentDir, { recursive: true, mode: 0o700 })
    mkdirSync(join(agentDir, 'workspace'), { recursive: true, mode: 0o700 })
    writeFileSync(
      join(agentDir, 'agent.json'),
      JSON.stringify(
        {
          id: agent.agentId,
          name: agent.alias,
          status: 'active',
          runtime: 'scripted',
          workspace: { mode: 'from-scratch', path: join(agentDir, 'workspace') },
          integrations: [],
          output: { mode: 'low', showFooter: false, showStatusBar: false }
        },
        null,
        2
      )
    )
  }
  return { root, secrets: [], cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

/**
 * Disposable REAL subject: the template's config (explicit runtime definitions,
 * provider credentials via runtime env) with each game seat materialized from a
 * template agent under the compiled UUID id. Control plane, relays, crons, MCP
 * servers, and platform integrations are stripped; account-app isolation is
 * FORCED on (the evaluation environment must stay the only integration
 * authority, so a subject may not inherit account-attached apps/connectors);
 * memory is off (game runs measure coordination, not recall); the workspace is
 * from-scratch. Every secret-shaped template value is harvested for redaction.
 */
export function prepareRealSubject(
  topology: CompiledTopology,
  spec: Extract<GameSubjectSpec, { kind: 'real' }>
): PreparedGameSubject {
  const sourceRoot = resolve(spec.subjectRoot)
  const configPath = join(sourceRoot, 'config.json')
  if (!existsSync(configPath)) throw new Error(`game subject template is missing ${configPath}`)
  if (spec.templateAgentIds.length === 0) throw new Error('real game subject requires at least one templateAgentId')
  const root = mkdtempSync(join(tmpdir(), 'ac-arena-real-'))
  const cleanup = () => rmSync(root, { recursive: true, force: true })
  try {
    assertNoSymlinks(configPath, 'game subject config')
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>
    const secrets = collectObjectSecrets(config)
    const runtimes =
      config.runtimes && typeof config.runtimes === 'object' && !Array.isArray(config.runtimes)
        ? (config.runtimes as Record<string, unknown>)
        : {}
    const templateSecurity =
      config.security && typeof config.security === 'object' && !Array.isArray(config.security)
        ? (config.security as Record<string, unknown>)
        : {}
    writeFileSync(
      join(root, 'config.json'),
      `${JSON.stringify(
        {
          ...config,
          daemonId: undefined,
          agentsDir: join(root, 'agents'),
          controlPlane: { enabled: false },
          relays: [],
          // Preserve the operator's security posture EXCEPT account-app reach:
          // a subject must not inherit account-attached apps/connectors.
          security: { ...templateSecurity, isolateAccountApps: true }
        },
        null,
        2
      )}\n`,
      { mode: 0o600 }
    )
    const sourceAgentsDir = join(sourceRoot, 'agents')
    assertNotSymlink(sourceAgentsDir, 'game subject agents directory')
    for (const [index, agent] of topology.agents.entries()) {
      const templateId = spec.templateAgentIds[index % spec.templateAgentIds.length]!
      if (templateId === '.' || templateId === '..' || /[/\\\0]/.test(templateId)) {
        throw new Error(`game subject template agent id is not a safe path segment: ${JSON.stringify(templateId)}`)
      }
      const sourceAgentDir = join(sourceAgentsDir, templateId)
      const sourceAgentPath = join(sourceAgentDir, 'agent.json')
      if (!existsSync(sourceAgentPath)) throw new Error(`game subject template has no agent "${templateId}"`)
      assertNotSymlink(sourceAgentDir, `game subject agent "${templateId}" directory`)
      assertNoSymlinks(sourceAgentPath, `game subject agent "${templateId}" config`)
      const template = JSON.parse(readFileSync(sourceAgentPath, 'utf8')) as Record<string, unknown>
      collectObjectSecrets(template, '', secrets)
      if (typeof template.runtime !== 'string' || !Object.prototype.hasOwnProperty.call(runtimes, template.runtime)) {
        throw new Error(`game subject agent "${templateId}" requires an explicit runtime definition in config.json`)
      }
      const targetAgentDir = join(root, 'agents', agent.agentId)
      mkdirSync(targetAgentDir, { recursive: true, mode: 0o700 })
      const workspacePath = join(targetAgentDir, 'workspace')
      mkdirSync(workspacePath, { recursive: true, mode: 0o700 })
      const sourceInstructions = join(sourceAgentDir, 'instructions.md')
      if (existsSync(sourceInstructions)) {
        assertNoSymlinks(sourceInstructions, `game subject agent "${templateId}" instructions`)
        cpSync(sourceInstructions, join(targetAgentDir, 'instructions.md'), { dereference: false })
      }
      const prepared = {
        ...template,
        id: agent.agentId,
        name: agent.alias,
        displayName: agent.alias,
        status: 'active',
        pause: false,
        integrations: [],
        crons: [],
        mcpServers: [],
        memory: { provider: 'none' },
        workspace: { mode: 'from-scratch', path: workspacePath, gitBranch: 'main', pullOnNewSession: true, skills: [] },
        output: { mode: 'low', showFooter: false, showStatusBar: false }
      }
      writeFileSync(join(targetAgentDir, 'agent.json'), `${JSON.stringify(prepared, null, 2)}\n`, { mode: 0o600 })
    }
    return {
      root,
      secrets: [...new Set([...secrets, ...environmentSecrets()].filter((secret) => secret.length >= 4))],
      cleanup
    }
  } catch (error) {
    cleanup()
    throw error
  }
}

export function prepareGameSubject(topology: CompiledTopology, spec: GameSubjectSpec): PreparedGameSubject {
  return spec.kind === 'scripted' ? prepareScriptedSubject(topology) : prepareRealSubject(topology, spec)
}

/** How long a runtime gets to prove it can start before the probe gives up and
 *  calls it healthy. An ACP adapter over stdio stays alive and silent, so the
 *  signal we are looking for is an EARLY non-zero exit. */
const RUNTIME_PROBE_MS = 20_000

/**
 * Preflight for a REAL subject: actually launch each runtime the prepared agents
 * reference and fail loudly if it cannot start.
 *
 * Without this, an unlaunchable runtime (the classic case is a corrupted npx
 * cache, which makes `npx -y <adapter>` exit immediately) produces a game that
 * simply never emits an effect: the runner burns its whole deadline, every wave
 * stalls, and the artifacts record an empty world with no explanation. A
 * two-second probe turns that into one actionable error naming the runtime, the
 * command and the child's own stderr.
 *
 * The probe is deliberately shallow — it does not speak ACP, authenticate, or
 * check a model. It answers exactly one question: does this command start?
 */
export async function preflightRealSubject(root: string, options: { probeMs?: number } = {}): Promise<void> {
  const probeMs = options.probeMs ?? RUNTIME_PROBE_MS
  const config = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8')) as {
    runtimes?: Record<string, { command?: string; args?: string[]; env?: { name: string; value: string }[] }>
  }
  const runtimes = config.runtimes ?? {}
  const needed = new Set<string>()
  const agentsDir = join(root, 'agents')
  for (const entry of readdirSync(agentsDir)) {
    const agentPath = join(agentsDir, entry, 'agent.json')
    if (!existsSync(agentPath)) continue
    const agent = JSON.parse(readFileSync(agentPath, 'utf8')) as { runtime?: string }
    if (typeof agent.runtime === 'string') needed.add(agent.runtime)
  }
  for (const name of needed) {
    const definition = runtimes[name]
    if (!definition?.command) {
      throw new Error(
        `game subject preflight: runtime "${name}" has no command in the template config.json — ` +
          `the game would start and then stall with zero agent effects.`
      )
    }
    await probeRuntime(name, definition, probeMs)
  }
  assertMcpBridgeEntry(root)
}

/**
 * The second silent failure of the real-subject path: the MCP bridge entry.
 *
 * A real runtime reaches the daemon's tools through a `mcp-bridge` SUBPROCESS,
 * spawned as `node <daemon CLI entry> mcp-bridge` (`daemonEntryForShims`). A
 * scripted host never uses it — it speaks the control socket directly — so
 * nothing in the scripted gate can catch a bad entry. When the entry is wrong,
 * the bridge cannot start, and the ACP session silently comes up with NO
 * AgentConnect tools at all: no `sendMessage`, and none of the §6 evaluation
 * tools the game's rules are made of. The model then improvises in prose and the
 * run looks like a model failure.
 *
 * `daemonEntryForShims` resolves `<root>/current/dist/index.js` and otherwise
 * falls back to `process.argv[1]` — which, for anything driving the arena from
 * source (a Vitest worker, `tsx`), is not the daemon CLI. Set
 * `AGENTCONNECT_DAEMON_ENTRY` to the built daemon bundle for real-subject runs.
 */
function assertMcpBridgeEntry(root: string): void {
  const override = process.env.AGENTCONNECT_DAEMON_ENTRY
  const resolved = override ?? (existsSync(join(root, 'current', 'dist', 'index.js')) ? 'current' : process.argv[1])
  const advice =
    'Set AGENTCONNECT_DAEMON_ENTRY to the built daemon bundle ' +
    '(packages/daemon/dist/index.js after `pnpm --filter @agentconnect.md/daemon build`).'
  if (resolved === 'current') return
  if (!resolved || !existsSync(resolved)) {
    throw new Error(
      `game subject preflight: the MCP bridge entry ${JSON.stringify(resolved ?? null)} does not exist, so a real ` +
        `runtime would start with no AgentConnect tools (no sendMessage, no evaluation tools). ${advice}`
    )
  }
  // A daemon bundle is the only thing that implements the `mcp-bridge` command.
  // Anything else — a Vitest worker, a test runner shim — silently no-ops.
  if (!readFileSync(resolved, 'utf8').includes('mcp-bridge')) {
    throw new Error(
      `game subject preflight: ${resolved} is not the AgentConnect daemon CLI (it has no "mcp-bridge" command), so ` +
        `a real runtime would start with no AgentConnect tools (no sendMessage, no evaluation tools). ${advice}`
    )
  }
}

async function probeRuntime(
  name: string,
  definition: { command?: string; args?: string[]; env?: { name: string; value: string }[] },
  probeMs: number
): Promise<void> {
  const command = definition.command!
  const args = definition.args ?? []
  const printable = [command, ...args].join(' ')
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const pair of definition.env ?? []) env[pair.name] = pair.value
  await new Promise<void>((resolve, reject) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(command, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env,
        // Own process group (POSIX) for exactly the reason `AcpHost` spawns its
        // adapter detached: an npx-distributed runtime runs the REAL adapter as a
        // grandchild of the npm wrapper, so killing the direct child orphans it —
        // measured: the grandchild survives, reparented to pid 1, holding its
        // inherited pipes and a credentialed process open. The group id (= child
        // pid) lets the probe signal wrapper + adapter together. Some adapters
        // happen to exit on stdin EOF and hide this; that is luck, not cleanup.
        detached: process.platform !== 'win32'
      })
    } catch (error) {
      reject(
        new Error(
          `game subject preflight: runtime "${name}" could not be spawned (${printable}): ${(error as Error).message}`
        )
      )
      return
    }
    // Signal the child's whole group when it has one; fall back to the direct
    // child on win32, or once the group is gone (ESRCH).
    const killTree = (signal: NodeJS.Signals) => {
      if (child.pid !== undefined && process.platform !== 'win32') {
        try {
          process.kill(-child.pid, signal)
          return
        } catch {
          /* group already gone — fall through to the direct child */
        }
      }
      try {
        child.kill(signal)
      } catch {
        /* already reaped */
      }
    }
    // Sweep group survivors the moment the leader exits, while its pgid provably
    // cannot have been recycled (a pgid stays reserved while any member lives).
    child.once('exit', () => {
      if (child.pid !== undefined && process.platform !== 'win32') {
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch {
          /* group already empty */
        }
      }
    })
    let stderr = ''
    let settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // Graceful first, then escalate — a wrapper that traps SIGTERM must not be
      // able to keep the probe's adapter alive past the run.
      killTree('SIGTERM')
      const escalation = setTimeout(() => killTree('SIGKILL'), 2_000)
      escalation.unref?.()
      if (error) reject(error)
      else resolve()
    }
    const timer = setTimeout(() => finish(), probeMs)
    // A long-lived stdio adapter never unrefs the test process on its own.
    timer.unref?.()
    child.stderr?.on('data', (data: Buffer) => {
      stderr = `${stderr}${data.toString()}`.slice(-2000)
    })
    child.on('error', (error) =>
      finish(
        new Error(`game subject preflight: runtime "${name}" could not be spawned (${printable}): ${error.message}`)
      )
    )
    child.on('exit', (code, signal) => {
      if (settled) return
      // Exiting at all this early means the runtime never came up. Even a clean
      // exit is a failure: an ACP adapter must stay alive on stdio.
      finish(
        new Error(
          `game subject preflight: runtime "${name}" exited immediately ` +
            `(code=${code ?? 'null'} signal=${signal ?? 'null'}) running \`${printable}\`. ` +
            `The game would stall with zero agent effects.` +
            (stderr.trim() ? ` Child stderr: ${stderr.trim()}` : '')
        )
      )
    })
  })
}
