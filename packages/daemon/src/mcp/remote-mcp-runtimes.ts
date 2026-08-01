import type { RuntimeDef } from '../config/config-schema.js'
import type { ResolvedRuntimeEntry } from '../runtimes/registry.js'

/**
 * Exact adapter launches validated for the remote `agentconnect-admin`
 * descriptor.
 *
 * Admission is an EXACT allowlist of complete launch shapes — command, full
 * argument vector, and empty env — each entry being one artifact the §13
 * behavioral harness (`test/remote-mcp-adapter-behavior.it.test.ts`) was run
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
 * x64, real authenticated adapter over npx against a live capture endpoint).
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
 * NOT admitted, evidence unmet:
 *  - @agentclientprotocol/codex-acp@1.1.7 — this adapter fetches `tools/list`
 *    over the attached descriptor but does not expose the resulting tools to
 *    the model: a turn explicitly instructed to call the probe tool produced
 *    ZERO `tools/call` requests, and the model reported the tool as
 *    unavailable to it. The §13 tool-execution evidence therefore cannot be
 *    established for this release, so it stays out of the allowlist (the
 *    feature would also be inert there). Re-run the harness if a later codex
 *    release surfaces remote MCP tools, then add that exact launch.
 *
 * The adapter resets its MCP request-id counter per descriptor installation,
 * not merely per process — a conversation-lifetime JSON-RPC id is therefore
 * never a durable operation identity, matching the §8 requirement that every
 * transport receipt be scoped to its access grant.
 */
const VALIDATED_REMOTE_MCP_LAUNCHES: Readonly<
  Record<string, ReadonlyArray<{ command: string; args: readonly string[] }>>
> = {
  'claude-acp': [{ command: 'npx', args: ['-y', '@agentclientprotocol/claude-agent-acp@0.64.0'] }]
}

/** Byte-exact launch identity: same command, same argument vector in order, and
 *  no environment injection. Any deviation is an untested configuration. */
function sameLaunch(def: RuntimeDef, validated: { command: string; args: readonly string[] }): boolean {
  return (
    def.command === validated.command &&
    def.args.length === validated.args.length &&
    def.args.every((arg, index) => arg === validated.args[index]) &&
    def.env.length === 0
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
 *     — a user-configured runtime, including one shadowing a validated id, is
 *     never admitted; and
 *  3. the resolved launch matches a validated launch EXACTLY (command, args,
 *     no env), so a newer/older/prerelease version, an added adapter flag, or
 *     a different package all fail closed.
 *
 * Callers additionally require the daemon's own ACP probe of this id to have
 * succeeded and advertised HTTP MCP transport (`runtimeMcpCaps`), so a
 * validated launch that is not actually installed and behaving stays out.
 */
export function isValidatedRemoteMcpRuntime(runtimeId: string, entry: ResolvedRuntimeEntry | undefined): boolean {
  const validated = VALIDATED_REMOTE_MCP_LAUNCHES[runtimeId]
  if (!validated || !entry) return false
  if (entry.source !== 'curated' && entry.source !== 'registry') return false
  return validated.some((launch) => sameLaunch(entry.runtime, launch))
}
