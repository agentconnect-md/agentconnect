import type { RuntimeDef } from '../config/config-schema.js'

/** Effort sentinel `'ultracode'` (matching Claude Code's own `ultracode` settings
 *  key) meaning xhigh reasoning PLUS standing dynamic-workflow orchestration. It is
 *  deliberately NOT a `thought_level` select value: the claude-acp runtime rejects
 *  effort="ultracode" ("Invalid value"). See `claudeSessionMeta` in acp-host.ts. */
export const ULTRACODE_EFFORT = 'ultracode'

/** A Claude Code runtime (its command/args reference `claude`) — these embed the
 *  @anthropic-ai/claude-agent-sdk, which needs a Claude Code executable. The ONE
 *  Claude predicate: AcpHost and the model-catalog path both delegate here, matching
 *  on the launch command line rather than the runtime id (which aliases between
 *  `claude` and `claude-acp`). */
export function isClaudeRuntimeDef(rt: RuntimeDef): boolean {
  return [rt.command, ...rt.args].join(' ').toLowerCase().includes('claude')
}

/** Append the synthetic Claude effort levels — `max` (session-only) and `ultracode`
 *  (xhigh + workflow orchestration), which aren't `thought_level` select values — to
 *  a model's advertised levels, skipping any it already offers. An empty input is
 *  returned as-is: a model with no effort selector must never gain synthetic levels.
 *  Shared by the live-session accessor path (effortOptionsFrom) and the catalog
 *  report path (the cache stores raw efforts; augmentation happens at report time). */
export function augmentClaudeEfforts(efforts: string[]): string[] {
  if (efforts.length === 0) return efforts
  const augmented = [...efforts]
  for (const extra of ['max', ULTRACODE_EFFORT]) if (!augmented.includes(extra)) augmented.push(extra)
  return augmented
}
