import type { RuntimeDef } from '../config/config-schema.js'
import type { ResolvedRuntimeEntry } from '../runtimes/registry.js'

/**
 * Exact adapter launches validated for the remote `agentconnect-admin`
 * descriptor.
 *
 * Admission is an EXACT allowlist of complete launch identities — catalog
 * version, command, full argument vector, empty env, and (where a binary command
 * does not pin the artifact) probed `agentInfo.version` — each entry being one
 * artifact the §13 behavioral harness
 * (`test/remote-mcp-adapter-behavior.it.test.ts`) was run
 * against on a real install. Nothing is extrapolated: a later release, a
 * prerelease, an extra adapter flag, or an injected env var is a DIFFERENT,
 * unvalidated launch configuration and fails closed until the harness is run
 * against it and this table is extended
 * (docs/designs/webchat-preset-agentconnect-mcp.md §13).
 *
 * Registry drift therefore disables the feature for that runtime rather than
 * silently authorizing an untested adapter; ordinary webchat is unaffected
 * (§11: a runtime that cannot carry the descriptor simply has no
 * `agentconnect-admin`).
 *
 * Validation record — harness run 2026-08-01 on the CURRENT harness (Linux
 * x64, real authenticated adapters using their registry launch definitions
 * against a live capture endpoint).
 * Every property is asserted non-vacuously: HTTP MCP capability at
 * `initialize`; bearer sent only to the descriptor endpoint; real `tools/call`
 * traffic where the endpoint fails the first probe call so §13's higher-level
 * retry is exercised, and the retry mints a fresh JSON-RPC id; no authorized
 * traffic from a descriptor-free session either before attachment or after a
 * sibling session in the same adapter process attached one, including when
 * that bare session completes a full turn explicitly attempting the probe
 * tool; clean rotation with zero requests carrying the retired bearer; no
 * bearer in model-visible `session/update` output under a mandatory reveal
 * prompt (a turn that cannot run fails the harness); no bearer in captured
 * adapter stderr, swept only after both adapter processes exit; and JSON-RPC
 * ids that reset on both descriptor replacement and adapter restart.
 *
 *  - npx -y @agentclientprotocol/claude-agent-acp@0.64.0 — ALL properties held:
 *    14 authorized requests, 2 probe `tools/call`s with distinct ids (the
 *    seeded transient failure was retried as a fresh request), bare-session
 *    probe turn produced zero authorized traffic, ids [0,1,2,3] → [0,1] on
 *    rotation → [0,1] after restart, 1216 bytes of diagnostics with no bearer
 *    material, and no bearer in the post-teardown model-output sweep.
 *
 *  - npx -y @agentclientprotocol/codex-acp@1.1.7 — ALL properties held:
 *    11 authorized requests, 2 probe `tools/call`s, ids [0,1,2,3] → [0,1]
 *    on rotation → [0,1] after restart, and 0 bytes of diagnostics.
 *  - ./opencode acp (registry 1.18.10; Linux x64 archive SHA-256
 *    6b1113da704253fb4da12b41e4236acecb9f2b62949c945f6eeacaa15111b976)
 *    — ALL properties held: 16 authorized requests, 2 probe `tools/call`s,
 *    ids [0,1,2,3] → [0,1] → [0,1], and 0 bytes of diagnostics.
 *  - npx -y @xai-official/grok@0.2.118 agent stdio — ALL properties held:
 *    11 authorized requests, 2 probe `tools/call`s, ids [0,1,2,3] → [0,1]
 *    on rotation → [0] after restart, and 337 bytes of clean diagnostics.
 *
 * NOT admitted, evidence unmet:
 *  - npx -y @agentconnect.md/codex-acp@1.1.8-agentconnect.1 connected its
 *    descriptor in the 2026-08-02 harness run, but two explicit probe turns
 *    produced zero `tools/call` requests. It therefore fails the non-vacuous
 *    tool-execution and retry requirements.
 *  - omp 17.0.5 satisfied transport, tool execution, isolation, rotation, and
 *    leak checks, but its random JSON-RPC ids did not reuse after rotation or
 *    restart. It therefore fails the current §13 restart-id-reuse requirement.
 *
 * The adapter resets its MCP request-id counter per descriptor installation,
 * not merely per process — a conversation-lifetime JSON-RPC id is therefore
 * never a durable operation identity, matching the §8 requirement that every
 * transport receipt be scoped to its access grant.
 */
const VALIDATED_REMOTE_MCP_LAUNCHES: Readonly<
  Record<string, ReadonlyArray<{ version: string; command: string; args: readonly string[]; probedVersion?: string }>>
> = {
  'claude-acp': [{ version: '0.64.0', command: 'npx', args: ['-y', '@agentclientprotocol/claude-agent-acp@0.64.0'] }],
  'codex-acp': [{ version: '1.1.7', command: 'npx', args: ['-y', '@agentclientprotocol/codex-acp@1.1.7'] }],
  opencode: [{ version: '1.18.10', command: './opencode', args: ['acp'], probedVersion: '1.18.10' }],
  'grok-build': [{ version: '0.2.118', command: 'npx', args: ['-y', '@xai-official/grok@0.2.118', 'agent', 'stdio'] }]
}

/** Byte-exact launch identity: same catalog version, command, argument vector
 *  in order, and no environment injection. Any deviation is unvalidated. */
function sameLaunch(
  entry: ResolvedRuntimeEntry,
  validated: { version: string; command: string; args: readonly string[]; probedVersion?: string },
  probedVersion: string | undefined
): boolean {
  const def: RuntimeDef = entry.runtime
  return (
    entry.version === validated.version &&
    def.command === validated.command &&
    def.args.length === validated.args.length &&
    def.args.every((arg, index) => arg === validated.args[index]) &&
    def.env.length === 0 &&
    (validated.probedVersion === undefined || probedVersion === validated.probedVersion)
  )
}

/**
 * Whether a runtime may receive the bearer-bearing remote MCP descriptor.
 *
 * Three independent conditions, all daemon-owned:
 *
 *  1. the id is a canonical adapter with validated evidence;
 *  2. its definition came from the daemon's own resolution of the curated
 *     catalog / public ACP registry document (`source: 'curated' | 'registry'`)
 *     — a user-configured runtime, including one shadowing a validated id, and
 *     an AgentConnect-managed build without passing evidence are never
 *     admitted; and
 *  3. the resolved launch matches a validated launch EXACTLY (catalog version,
 *     command, args, no env), and binary launches whose command does not pin an
 *     artifact additionally match the actual `agentInfo.version` observed by
 *     the live ACP probe. A newer/older/prerelease version, an added adapter
 *     flag, or a different package all fail closed.
 *
 * Callers additionally require the daemon's own ACP probe of this id to have
 * succeeded and advertised HTTP MCP transport (`runtimeMcpCaps`), so a
 * validated launch that is not actually installed and behaving stays out.
 */
export function isValidatedRemoteMcpRuntime(
  runtimeId: string,
  entry: ResolvedRuntimeEntry | undefined,
  probedVersion?: string
): boolean {
  const validated = VALIDATED_REMOTE_MCP_LAUNCHES[runtimeId]
  if (!validated || !entry) return false
  if (entry.source !== 'curated' && entry.source !== 'registry') return false
  return validated.some((launch) => sameLaunch(entry, launch, probedVersion))
}
