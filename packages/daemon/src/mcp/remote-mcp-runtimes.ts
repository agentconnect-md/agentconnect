import type { RuntimeDef } from '../config/config-schema.js'
import type { ResolvedRuntimeEntry } from '../runtimes/registry.js'

/**
 * Adapter artifacts validated for the remote `agentconnect-admin` descriptor.
 *
 * Admission is bound to the exact npm artifact whose descriptor behavior is
 * covered by the §13 behavioral harness
 * (`test/remote-mcp-adapter-behavior.it.test.ts`, run against a real adapter
 * install): MCP `headers` consumed purely as transport configuration — sent
 * only to the descriptor's endpoint, absent from model-visible output and
 * adapter diagnostics — with per-ACP-session descriptor scoping and clean
 * descriptor replacement across session rebuilds. `minValidatedVersion` is the
 * lowest release that evidence covers; the registry pins an exact version in
 * the launch specifier, so anything older fails closed. Extending this table
 * requires re-running the harness against the new artifact
 * (docs/designs/webchat-preset-agentconnect-mcp.md §13).
 *
 * Validation record (harness run 2026-08-01, Linux x64, real adapters over
 * npx against a live capture endpoint, model-visibility prompt included):
 *  - @agentclientprotocol/claude-agent-acp@0.64.0 — all five properties held
 *    (8 authorized MCP requests observed, prompt leak check ran).
 *  - @agentclientprotocol/codex-acp@1.1.7 — all five properties held
 *    (4 authorized MCP requests observed, prompt leak check ran).
 */
const VALIDATED_REMOTE_MCP_ADAPTERS: Readonly<Record<string, { npmPackage: string; minValidatedVersion: string }>> = {
  'claude-acp': { npmPackage: '@agentclientprotocol/claude-agent-acp', minValidatedVersion: '0.64.0' },
  'codex-acp': { npmPackage: '@agentclientprotocol/codex-acp', minValidatedVersion: '1.1.7' }
}

/** `major.minor.patch` at-least comparison; anything unparseable fails closed. */
function atLeast(version: string, floor: string): boolean {
  const parse = (value: string): number[] | null => {
    const parts = value.split('.').map((part) => Number.parseInt(part, 10))
    return parts.length >= 3 && parts.slice(0, 3).every((part) => Number.isFinite(part) && part >= 0)
      ? parts.slice(0, 3)
      : null
  }
  const have = parse(version)
  const want = parse(floor)
  if (!have || !want) return false
  for (let i = 0; i < 3; i++) {
    if (have[i]! > want[i]!) return true
    if (have[i]! < want[i]!) return false
  }
  return true
}

/** The resolved launch must be exactly the validated npx artifact at or above
 *  the validated version floor — `toRuntimeDef` shapes npx distributions as
 *  `npx -y <package>@<version>`, so this pins the artifact the daemon runs. */
function matchesValidatedArtifact(
  def: RuntimeDef,
  validated: { npmPackage: string; minValidatedVersion: string }
): boolean {
  if (def.command !== 'npx' || def.args[0] !== '-y') return false
  const specifier = def.args[1]
  if (typeof specifier !== 'string') return false
  const at = specifier.lastIndexOf('@')
  if (at <= 0) return false // an unpinned specifier proves nothing about the artifact version
  const packageName = specifier.slice(0, at)
  const version = specifier.slice(at + 1)
  return packageName === validated.npmPackage && atLeast(version, validated.minValidatedVersion)
}

/**
 * Whether a runtime may receive the bearer-bearing remote MCP descriptor.
 *
 * The binding is daemon-owned adapter provenance down to the artifact, not
 * launch-line inference: the id must be a validated canonical adapter, its
 * definition must come from the daemon's own resolution of the curated
 * catalog / public ACP registry document (`source: 'curated' | 'registry'`,
 * never a user-configured runtime — including one shadowing a validated id),
 * AND the resolved launch must be exactly the validated npm artifact at or
 * above the version the §13 evidence covers. A registry entry that drifts to a
 * different command, package, or an older release fails closed. Callers
 * additionally require the daemon's own ACP probe of this id to have
 * succeeded and advertised HTTP MCP transport (`runtimeMcpCaps`).
 */
export function isValidatedRemoteMcpRuntime(runtimeId: string, entry: ResolvedRuntimeEntry | undefined): boolean {
  const validated = VALIDATED_REMOTE_MCP_ADAPTERS[runtimeId]
  if (!validated || !entry) return false
  if (entry.source !== 'curated' && entry.source !== 'registry') return false
  return matchesValidatedArtifact(entry.runtime, validated)
}
