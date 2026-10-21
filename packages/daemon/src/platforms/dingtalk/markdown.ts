// DingTalk's Markdown dialect (dingtalk-integration.md §4.3): rewrite what its Markdown message renders wrong.
import type { Nodes } from 'mdast'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { FENCE } from '../../messages/split-markdown-bytes.js'

// A no-break space survives where DingTalk drops a plain one; needs live verification on each client.
const KEEP_SPACE = ' '

interface Edit {
  start: number
  end: number
  text: string
}

/** Rewrite Markdown for a DingTalk Markdown message: `_x_` → `*x*`, a kept space before inline styles and links, no fence language. */
export function rewriteDingTalkMarkdown(text: string): string {
  if (!text) return text
  const edits: Edit[] = []
  const visit = (node: Nodes): void => {
    const start = node.position?.start.offset
    const end = node.position?.end.offset
    if (start !== undefined && end !== undefined) {
      if (node.type === 'emphasis' || node.type === 'strong') underscoreToAsterisk(text, start, end, edits)
      if (['emphasis', 'strong', 'inlineCode', 'link'].includes(node.type) && text[start - 1] === ' ')
        edits.push({ start: start - 1, end: start, text: KEEP_SPACE })
      if (node.type === 'code') dropFenceLanguage(text, start, edits)
    }
    if ('children' in node) for (const child of node.children) visit(child)
  }
  visit(fromMarkdown(text))
  let out = text
  for (const edit of edits.sort((a, b) => b.start - a.start))
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end)
  return out
}

// DingTalk shows `_x_` literally; `*` is the same emphasis, and `__x__` the same strong.
function underscoreToAsterisk(text: string, start: number, end: number, edits: Edit[]): void {
  let width = 0
  while (width < 2 && text[start + width] === '_' && text[end - 1 - width] === '_') width++
  if (!width || text[start + width] === '*' || text[end - 1 - width] === '*') return
  const marker = '*'.repeat(width)
  edits.push({ start, end: start + width, text: marker }, { start: end - width, end, text: marker })
}

// DingTalk ignores a fence's language and may print it, so the info string is dropped.
function dropFenceLanguage(text: string, start: number, edits: Edit[]): void {
  const lineEnd = text.indexOf('\n', start)
  const line = text.slice(start, lineEnd === -1 ? text.length : lineEnd)
  const match = FENCE.exec(line)
  if (!match?.[1] || !match[2]?.trim()) return
  edits.push({ start: start + line.length - match[2].length, end: start + line.length, text: '' })
}
