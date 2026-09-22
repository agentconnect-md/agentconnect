import { fromMarkdown } from 'mdast-util-from-markdown'
import type { Nodes } from 'mdast'

export const QQTextMaxBytes = 4000
export const QQProgressMaxBytes = 1200
export const QQTextBoundaries = new Set(['agent_thought_chunk', 'tool_call', 'tool_call_update', 'plan'])

// Keep literal punctuation stable when a later unsafe link causes the shared renderer to escape it.
export function QQStreamText(text: string, complete = false): string {
  const literals: { start: number; end: number }[] = []
  let hold = text.length
  const visit = (node: Nodes): void => {
    if (node.type === 'text') {
      const start = node.position!.start.offset!
      const end = node.position!.end.offset!
      literals.push({ start, end })
      if (!complete) {
        const raw = text.slice(start, end)
        // Unclosed code or markup can still change literal escaping, including across text nodes and whitespace.
        for (const match of raw.matchAll(/\\.|(`+|<(?=\S|$))/g)) {
          if (match[1]) hold = Math.min(hold, start + match.index)
        }
      }
    }
    if ('children' in node) node.children.forEach(visit)
  }
  visit(fromMarkdown(text))
  let rendered = text.slice(0, hold)
  for (const { start, end } of literals.reverse()) {
    if (start >= hold) continue
    const stop = Math.min(end, hold)
    const escaped = text
      .slice(start, stop)
      .replace(/\\.|[<[\]]/g, (token) => (token.length === 1 ? `\\${token}` : token))
    rendered = rendered.slice(0, start) + escaped + rendered.slice(stop)
  }
  return rendered
}
