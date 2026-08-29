/**
 * Pull human-readable output text out of an ACP tool_call/_update — the ONE copy every
 * platform renderer uses, so a runtime's shape learned once is learned everywhere.
 *
 * Prefers the `content[]` text blocks (the tool's reported output); diff / terminal blocks are
 * skipped — they have no compact inline text. `rawOutput` is the fallback, and it is not one
 * shape: codex-acp sends NO content for a finished shell command — the output rides
 * `rawOutput.formatted_output` (folded there at ACP ingress by `TerminalOutputFolder`) — and
 * wraps an MCP tool's result as `rawOutput.result.content[]` text blocks.
 */
export function extractToolOutput(update: { content?: unknown; rawOutput?: unknown }): string {
  const content = update.content
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const item of content) {
      if (!item || typeof item !== 'object') continue
      if ((item as { type?: string }).type !== 'content') continue
      const block = (item as { content?: { type?: string; text?: string } }).content
      if (block?.type === 'text' && block.text) parts.push(block.text)
    }
    if (parts.length) return parts.join('\n').trim()
  }
  const raw = update.rawOutput
  if (typeof raw === 'string') return raw.trim()
  if (raw && typeof raw === 'object') {
    const r = raw as { formatted_output?: unknown; result?: { content?: unknown } }
    if (typeof r.formatted_output === 'string') return r.formatted_output.trim()
    const nested = r.result?.content
    if (Array.isArray(nested)) {
      const parts = nested
        .filter((b): b is { type: string; text: string } => {
          const x = b as { type?: unknown; text?: unknown } | null
          return !!x && x.type === 'text' && typeof x.text === 'string'
        })
        .map((b) => b.text)
      if (parts.length) return parts.join('\n').trim()
    }
  }
  return ''
}
