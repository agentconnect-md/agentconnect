// WeChat shows text as typed, so an answer is reduced to plain text and sent in paragraph-bounded parts (wechat-integration.md §4.4).
import { fromMarkdown } from 'mdast-util-from-markdown'
import type { Nodes, RootContent } from 'mdast'

/** The per-message ceiling until a probe finds the real one (§4.4, §9.3). */
export const WECHAT_TEXT_MAX_CHARS = 2000

function inline(node: Nodes): string {
  switch (node.type) {
    case 'text':
    case 'inlineCode':
    case 'html':
      return node.value
    case 'break':
      return '\n'
    case 'image':
      return node.alt || node.url
    case 'link': {
      const label = node.children.map(inline).join('')
      return !label || label === node.url ? node.url : `${label} (${node.url})`
    }
    default:
      return 'children' in node ? node.children.map(inline).join('') : ''
  }
}

function block(node: RootContent): string {
  switch (node.type) {
    case 'code':
      return node.value
    case 'thematicBreak':
      return ''
    case 'blockquote':
      return node.children
        .map(block)
        .filter(Boolean)
        .join('\n\n')
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n')
    case 'list':
      return node.children
        .map((item, index) => {
          const marker = node.ordered ? `${(node.start ?? 1) + index}. ` : '- '
          const body = item.children.map(block).filter(Boolean).join('\n')
          return marker + body.split('\n').join(`\n${' '.repeat(marker.length)}`)
        })
        .join('\n')
    default:
      return inline(node)
  }
}

/** The answer's blocks as plain text, headings, emphasis and fences reduced to their text. */
export function weChatPlainBlocks(markdown: string): string[] {
  return fromMarkdown(markdown)
    .children.map(block)
    .map((text) => text.replace(/\s+$/, ''))
    .filter((text) => text.trim())
}

export function weChatPlainText(markdown: string): string {
  return weChatPlainBlocks(markdown).join('\n\n')
}

// A block over the ceiling is cut at line breaks, and a line over it at the ceiling itself.
function cut(text: string, limit: number): string[] {
  if (text.length <= limit) return [text]
  const parts: string[] = []
  let current = ''
  for (const line of text.split('\n')) {
    const next = current ? `${current}\n${line}` : line
    if (next.length <= limit) {
      current = next
      continue
    }
    if (current) parts.push(current)
    current = line
    while (current.length > limit) {
      parts.push(current.slice(0, limit))
      current = current.slice(limit)
    }
  }
  if (current) parts.push(current)
  return parts
}

/** The messages one answer is sent as: whole paragraphs packed under `limit`, never cut mid-paragraph unless one alone exceeds it. */
export function splitWeChatText(markdown: string, limit = WECHAT_TEXT_MAX_CHARS): string[] {
  const parts: string[] = []
  let current = ''
  for (const paragraph of weChatPlainBlocks(markdown).flatMap((text) => cut(text, limit))) {
    const next = current ? `${current}\n\n${paragraph}` : paragraph
    if (next.length <= limit) current = next
    else {
      parts.push(current)
      current = paragraph
    }
  }
  if (current) parts.push(current)
  return parts
}
