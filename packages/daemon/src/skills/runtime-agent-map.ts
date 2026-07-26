/**
 * Map an AgentConnect runtime id to the `npx skills` agent identifier used by
 * vercel-labs/skills (docs/designs/shared-skills.md §6.2). The CLI knows each
 * agent's per-runtime skills directory, so we only need to name the agent.
 *
 * Returns undefined when no native mapping exists — the caller then skips the
 * `npx skills` install for that runtime (the prompt-fallback path is P2, §6.5).
 * Matching is by substring so both bare ids ("claude") and ACP-suffixed ids
 * ("claude-acp") resolve.
 */
export function skillsAgentId(runtime: string): string | undefined {
  const r = runtime.toLowerCase()
  if (r.includes('claude')) return 'claude-code'
  if (r.includes('codex')) return 'codex'
  if (r.includes('opencode')) return 'opencode'
  if (r.includes('gemini') || r.includes('qwen')) return 'gemini-cli'
  if (r.includes('cursor')) return 'cursor'
  return undefined
}
