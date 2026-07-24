// Test harness for the daemon↔ACP integration matrix.
//
// Two seams, both against a REAL subprocess (test/fixtures/scriptable-acp-agent.mjs):
//   - bootHost():      drives the daemon's AcpHost directly (the ACP client surface).
//   - runDaemonTurn(): boots the full Daemon and drives a webchat turn through dispatch,
//                      so the reply stream is proven end-to-end through daemon wiring.
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AcpHost, type AcpPermissionPolicyEvent } from '../../src/acp/acp-host.js'
import type { RuntimeDef } from '../../src/config/config-schema.js'
import { Daemon } from '../../src/daemon.js'
import type { Profile, Scenario } from './profiles.js'

const here = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(here, '..', 'fixtures', 'scriptable-acp-agent.mjs')

/** Copy the fixture into `dir` under a name that controls Claude-runtime detection:
 *  AcpHost.isClaudeRuntime() scans command+args for "claude", and the worktree path
 *  itself contains ".claude", so the spawned command path must be the sole signal — a
 *  temp copy (clean tmp path) named `claude-agent.mjs` or `agent.mjs` decides it. */
function fixtureCopy(dir: string, claudeRuntime?: boolean): string {
  const path = join(dir, claudeRuntime ? 'claude-agent.mjs' : 'agent.mjs')
  copyFileSync(FIXTURE, path)
  return path
}

/** Deep-merge a scenario override onto a profile's base scenario (prompt-level merge). */
function mergeScenario(base: Scenario, override?: Partial<Scenario>): Scenario {
  if (!override) return base
  return { ...base, ...override, prompt: { ...base.prompt, ...override.prompt } }
}

/** Materialize a scenario to a temp file and return a RuntimeDef spawning the fixture
 *  (via a temp copy whose name drives Claude-runtime detection — see fixtureCopy). */
function runtimeFor(profile: Profile, scenario: Scenario): RuntimeDef {
  const dir = mkdtempSync(join(tmpdir(), `ac-acp-${profile.id}-`))
  const scenarioPath = join(dir, 'scenario.json')
  writeFileSync(scenarioPath, JSON.stringify(scenario))
  const agentPath = fixtureCopy(dir, profile.claudeRuntime)
  return { command: process.execPath, args: [agentPath], env: [{ name: 'AC_SCENARIO', value: scenarioPath }] }
}

export interface HostHandle {
  host: AcpHost
  /** All session/update payloads the host forwarded (post load-filtering). */
  updates: Array<{ sessionId: string; update: any }>
  /** agent_message_chunk texts, in order. */
  texts: () => string[]
  /** Metadata-only permission decisions emitted by the real ACP client policy. */
  permissionEvents: Array<{ sessionId: string; event: AcpPermissionPolicyEvent }>
  stop: () => Promise<void>
}

/** Boot a started AcpHost against a profile (optionally with a scenario override and
 *  interactive permission/elicit resolvers). */
export async function bootHost(
  profile: Profile,
  opts: {
    override?: Partial<Scenario>
    onPermission?: AcpHostOpts['onPermission']
    onPermissionEvent?: AcpHostOpts['onPermissionEvent']
    onElicit?: AcpHostOpts['onElicit']
  } = {}
): Promise<HostHandle> {
  const scenario = mergeScenario(profile.scenario, opts.override)
  const updates: Array<{ sessionId: string; update: any }> = []
  const permissionEvents: Array<{ sessionId: string; event: AcpPermissionPolicyEvent }> = []
  const host = new AcpHost(runtimeFor(profile, scenario), {
    onUpdate: (sessionId, update) => updates.push({ sessionId, update }),
    onPermission: opts.onPermission,
    onPermissionEvent: (sessionId, params, event) => {
      permissionEvents.push({ sessionId, event })
      opts.onPermissionEvent?.(sessionId, params, event)
    },
    onElicit: opts.onElicit
  })
  await host.start()
  return {
    host,
    updates,
    texts: () =>
      updates
        .filter((u) => u.update?.sessionUpdate === 'agent_message_chunk' && u.update?.content?.type === 'text')
        .map((u) => u.update.content.text as string),
    permissionEvents,
    stop: () => host.stop()
  }
}

type AcpHostOpts = ConstructorParameters<typeof AcpHost>[1]

// ── Full-daemon seam ────────────────────────────────────────────────────────────

const AGENT_ID = 'bot-a'
export const CONV = '88888888-8888-4888-8888-888888888888'

/** Scaffold a daemon root whose runtime `<profile.id>` spawns the fixture. */
function scaffoldDaemonRoot(profile: Profile): string {
  const scenario = profile.scenario
  const dir = mkdtempSync(join(tmpdir(), `ac-daemon-${profile.id}-`))
  const scenarioPath = join(dir, 'scenario.json')
  writeFileSync(scenarioPath, JSON.stringify(scenario))
  const agentPath = fixtureCopy(dir, profile.claudeRuntime)
  writeFileSync(
    join(dir, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      runtimes: {
        [profile.id]: {
          command: process.execPath,
          args: [agentPath],
          env: [{ name: 'AC_SCENARIO', value: scenarioPath }]
        }
      }
    })
  )
  const adir = join(dir, 'agents', AGENT_ID)
  mkdirSync(adir, { recursive: true })
  writeFileSync(
    join(adir, 'agent.json'),
    JSON.stringify({
      id: AGENT_ID,
      name: AGENT_ID,
      status: 'active',
      runtime: profile.id,
      workspace: { mode: 'from-scratch', path: join(adir, 'workspace') },
      integrations: [],
      output: { mode: 'medium' }
    })
  )
  return dir
}

export interface DaemonReply {
  events: any[]
  dones: any[]
  texts: string[]
}

/** Boot the full Daemon (real subprocess, no hostFactory), run one webchat turn, and
 *  return the captured reply stream. */
export async function runDaemonTurn(
  profile: Profile,
  text: string
): Promise<{ reply: DaemonReply; stop: () => Promise<void> }> {
  const root = scaffoldDaemonRoot(profile)
  // Real AcpHost (no hostFactory) so the fixture subprocess is exercised end-to-end,
  // but stub the post-connect probe sweep so start() doesn't spawn extra subprocesses.
  const daemon = new Daemon({ root, probeRuntimes: async () => [] })
  await daemon.start()
  const outputs: any[] = []
  const dones: any[] = []
  const cp = {
    emitUsageReport: () => {},
    stop: async () => {},
    sink: { output: (o: any) => outputs.push(o), done: (d: any) => dones.push(d) }
  }
  ;(daemon as any).cpClient = cp

  const turnId = '77777777-7777-4777-8777-777777777777'
  const msg = {
    msgId: `webchat:${CONV}:${turnId}`,
    traceId: turnId,
    source: 'user' as const,
    platform: 'webchat' as const,
    channel: CONV,
    sender: { id: 'alice', isBot: false },
    text,
    mentionedBots: [] as string[],
    isDm: true,
    trigger: 'dm' as const
  }
  await (daemon as any).dispatch(AGENT_ID, msg, undefined, { conversationId: CONV, turnId, sink: cp.sink })

  const events = outputs.filter((o) => o.event).map((o) => o.event)
  return {
    reply: { events, dones, texts: events.filter((e) => e.kind === 'message').map((e) => e.text) },
    stop: () => daemon.stop()
  }
}
