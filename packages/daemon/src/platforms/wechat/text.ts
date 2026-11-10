// WeChat shows text as typed, so an answer is reduced to plain text and sent in paragraph-bounded parts (wechat-integration.md §4.4).
import { fromMarkdown } from 'mdast-util-from-markdown'
import type { Nodes, Root, RootContent } from 'mdast'

/** The per-message ceiling until a probe finds the real one (§4.4, §9.3). */
export const WECHAT_TEXT_MAX_CHARS = 2000

// Reference definitions by their normalized label, so `[text][ref]` renders like an inline link.
type Definitions = ReadonlyMap<string, string>

function definitionsOf(root: Root): Definitions {
  const urls = new Map<string, string>()
  const visit = (node: Nodes): void => {
    if (node.type === 'definition' && !urls.has(node.identifier)) urls.set(node.identifier, node.url)
    if ('children' in node) for (const child of node.children) visit(child)
  }
  visit(root)
  return urls
}

function linkText(label: string, url: string | undefined): string {
  if (!url) return label
  return !label || label === url ? url : `${label} (${url})`
}

function inline(node: Nodes, defs: Definitions): string {
  switch (node.type) {
    case 'text':
    case 'inlineCode':
    case 'html':
      return node.value
    case 'break':
      return '\n'
    case 'image':
      return node.alt || node.url
    case 'imageReference':
      return node.alt || defs.get(node.identifier) || ''
    case 'link':
      return linkText(node.children.map((child) => inline(child, defs)).join(''), node.url)
    case 'linkReference':
      return linkText(node.children.map((child) => inline(child, defs)).join(''), defs.get(node.identifier))
    case 'definition':
      return ''
    default:
      return 'children' in node ? node.children.map((child) => inline(child, defs)).join('') : ''
  }
}

function block(node: RootContent, defs: Definitions): string {
  switch (node.type) {
    case 'code':
      return node.value
    case 'thematicBreak':
      return ''
    case 'blockquote':
      return node.children
        .map((child) => block(child, defs))
        .filter(Boolean)
        .join('\n\n')
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n')
    case 'list':
      return node.children
        .map((item, index) => {
          const marker = node.ordered ? `${(node.start ?? 1) + index}. ` : '- '
          const body = item.children
            .map((child) => block(child, defs))
            .filter(Boolean)
            .join('\n')
          return marker + body.split('\n').join(`\n${' '.repeat(marker.length)}`)
        })
        .join('\n')
    default:
      return inline(node, defs)
  }
}

/** The answer's blocks as plain text, headings, emphasis and fences reduced to their text. */
export function weChatPlainBlocks(markdown: string): string[] {
  const root = fromMarkdown(markdown)
  const defs = definitionsOf(root)
  return root.children
    .map((node) => block(node, defs))
    .map((text) => text.replace(/\s+$/, ''))
    .filter((text) => text.trim())
}

export function weChatPlainText(markdown: string): string {
  return weChatPlainBlocks(markdown).join('\n\n')
}

// A cut at `limit` that would split a surrogate pair moves back one code unit, keeping the character whole.
function cutPoint(text: string, limit: number): number {
  const unit = text.charCodeAt(limit - 1)
  return limit > 1 && unit >= 0xd800 && unit <= 0xdbff ? limit - 1 : limit
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
      const at = cutPoint(current, limit)
      parts.push(current.slice(0, at))
      current = current.slice(at)
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
