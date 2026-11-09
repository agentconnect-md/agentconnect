// The agent's Markdown reply as Telegram HTML (parse_mode HTML): only the tags Telegram accepts, everything else as escaped text.
import type { Definition, Nodes, Parents, RootContent } from 'mdast'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { escapeHtml } from './render.js'

const BULLETS = ['•', '◦', '▪']
const SAFE_HREF = /^https?:\/\//i
const LANGUAGE = /^[\w#+.-]+$/

interface Ctx {
  source: string
  definitions: Map<string, string>
  quoted: boolean
  listDepth: number
}

/** Escape a value for a double-quoted HTML attribute. */
function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;')
}

/** The node's own source text, escaped — the fallback for anything Telegram has no tag for. */
function sourceOf(node: Nodes, ctx: Ctx): string {
  const start = node.position?.start.offset
  const end = node.position?.end.offset
  if (start === undefined || end === undefined) return ''
  return escapeHtml(ctx.source.slice(start, end))
}

function anchor(url: string, label: string): string {
  return SAFE_HREF.test(url) ? `<a href="${escapeAttr(url)}">${label || escapeHtml(url)}</a>` : label || escapeHtml(url)
}

function inline(nodes: readonly Nodes[], ctx: Ctx): string {
  return nodes.map((n) => inlineNode(n, ctx)).join('')
}

function inlineNode(node: Nodes, ctx: Ctx): string {
  switch (node.type) {
    case 'text':
      return escapeHtml(node.value)
    case 'strong':
      return `<b>${inline(node.children, ctx)}</b>`
    case 'emphasis':
      return `<i>${inline(node.children, ctx)}</i>`
    case 'delete':
      return `<s>${inline(node.children, ctx)}</s>`
    case 'inlineCode':
      return `<code>${escapeHtml(node.value)}</code>`
    case 'break':
      return '\n'
    case 'link':
      return anchor(node.url, inline(node.children, ctx))
    case 'image':
      return anchor(node.url, escapeHtml(node.alt ?? ''))
    case 'linkReference':
    case 'imageReference': {
      const url = ctx.definitions.get(node.identifier)
      if (url === undefined) return sourceOf(node, ctx)
      return anchor(url, node.type === 'linkReference' ? inline(node.children, ctx) : escapeHtml(node.alt ?? ''))
    }
    case 'html':
      return escapeHtml(node.value)
    default:
      return 'children' in node ? inline(node.children, ctx) : sourceOf(node, ctx)
  }
}

function blocks(nodes: readonly RootContent[], ctx: Ctx, separator = '\n\n'): string {
  return nodes
    .filter((n) => n.type !== 'definition')
    .map((n) => block(n, ctx))
    .filter((s) => s.length > 0)
    .join(separator)
}

function block(node: RootContent, ctx: Ctx): string {
  switch (node.type) {
    case 'paragraph':
      return inline(node.children, ctx)
    case 'heading':
      return `<b>${inline(node.children, ctx)}</b>`
    case 'thematicBreak':
      return '———'
    case 'code': {
      const body = escapeHtml(node.value)
      const lang = node.lang && LANGUAGE.test(node.lang) ? node.lang : undefined
      return lang ? `<pre><code class="language-${escapeAttr(lang)}">${body}</code></pre>` : `<pre>${body}</pre>`
    }
    case 'blockquote': {
      // Telegram rejects a blockquote nested in another, so an inner quote renders as plain lines.
      if (ctx.quoted) return blocks(node.children, ctx)
      return `<blockquote>${blocks(node.children, { ...ctx, quoted: true })}</blockquote>`
    }
    case 'list': {
      const bullet = BULLETS[ctx.listDepth % BULLETS.length]!
      const start = node.start ?? 1
      const inner = { ...ctx, listDepth: ctx.listDepth + 1 }
      const items = node.children.map((item, i) => {
        const marker = node.ordered ? `${start + i}. ` : `${bullet} `
        const body = blocks(item.children, inner, item.spread ? '\n\n' : '\n')
        const pad = ' '.repeat(marker.length)
        return marker + body.split('\n').join(`\n${pad}`)
      })
      return items.join(node.spread ? '\n\n' : '\n')
    }
    case 'html':
      return escapeHtml(node.value)
    default:
      return 'children' in node ? inline((node as Parents).children as Nodes[], ctx) : sourceOf(node, ctx)
  }
}

function collectDefinitions(node: Nodes, into: Map<string, string>): void {
  if (node.type === 'definition') {
    const def = node as Definition
    if (!into.has(def.identifier)) into.set(def.identifier, def.url)
  }
  if ('children' in node) for (const child of node.children) collectDefinitions(child, into)
}

/** Convert one Markdown section to Telegram HTML; its rendered text is usually no longer than the source, and the connection guards the rest. */
export function markdownToTelegramHtml(markdown: string): string {
  const tree = fromMarkdown(markdown)
  const definitions = new Map<string, string>()
  collectDefinitions(tree, definitions)
  return blocks(tree.children, { source: markdown, definitions, quoted: false, listDepth: 0 })
}

/** The length Telegram counts for an HTML message: the text left once tags and entities are parsed, in UTF-16 units. */
export function telegramHtmlLength(html: string): number {
  return html.replace(/<[^>]*>/g, '').replace(/&(?:lt|gt|quot|amp);/g, '_').length
}
