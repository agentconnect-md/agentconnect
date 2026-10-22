// DingTalk's Markdown dialect (dingtalk-integration.md §4.3): rewrite what its Markdown message renders wrong.
import type { Nodes } from 'mdast'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { FENCE } from '../../messages/split-markdown-bytes.js'

// A no-break space survives where DingTalk drops a plain one; needs live verification on each client.
const KEEP_SPACE = ' '
const INLINE_STYLES = new Set(['emphasis', 'strong', 'inlineCode', 'link'])

interface Edit {
  start: number
  end: number
  text: string
}

/** Rewrite Markdown for a DingTalk Markdown message: `_x_` → `*x*`, a kept space before inline styles and links, no fence language, a blank line before a table. */
export function rewriteDingTalkMarkdown(text: string): string {
  if (!text) return text
  const edits: Edit[] = []
  const code: [number, number][] = []
  const visit = (node: Nodes, index: number): void => {
    const start = node.position?.start.offset
    const end = node.position?.end.offset
    if (start !== undefined && end !== undefined) {
      if (node.type === 'emphasis' || node.type === 'strong') underscoreToAsterisk(text, start, end, edits)
      // Only a space between inline siblings: a first child's space belongs to its list, heading or quote marker.
      if (INLINE_STYLES.has(node.type) && index > 0 && text[start - 1] === ' ' && /\S/.test(text[start - 2] ?? ''))
        edits.push({ start: start - 1, end: start, text: KEEP_SPACE })
      if (node.type === 'code') {
        code.push([start, end])
        dropFenceLanguage(text, start, edits)
      }
    }
    if ('children' in node) node.children.forEach((child, i) => visit(child, i))
  }
  visit(fromMarkdown(text), 0)
  separateTables(text, code, edits)
  let out = text
  // At one offset an insertion applies last, so it lands before the text replaced there.
  for (const edit of edits.sort((a, b) => b.start - a.start || b.end - a.end))
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

const TABLE_DELIMITER = /^ {0,3}\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/

const isTableRow = (line: string): boolean => line.trim().startsWith('|')

// DingTalk renders a table only after a blank line; one right under a paragraph line shows as that paragraph's text.
function separateTables(text: string, code: [number, number][], edits: Edit[]): void {
  const lines = text.split('\n')
  let offset = 0
  for (const [i, line] of lines.entries()) {
    const start = offset
    offset += line.length + 1
    const prev = lines[i - 1]
    const delimiter = lines[i + 1]
    if (!prev?.trim() || isTableRow(prev) || !delimiter?.includes('|') || !TABLE_DELIMITER.test(delimiter)) continue
    if (!line.includes('|') || line.trim().startsWith('>')) continue
    if (code.some(([from, to]) => start >= from && start < to)) continue
    edits.push({ start, end: start, text: '\n' })
  }
}
