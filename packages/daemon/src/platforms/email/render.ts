// A reply's subject, threading headers and bodies (email-integration.md §6.1): the agent's Markdown as plain text and as simple HTML.
import type { Definition, Nodes, Parents, RootContent } from 'mdast'
import { fromMarkdown } from 'mdast-util-from-markdown'
import {
  EMAIL_REFERENCES_MAX,
  EMAIL_SEND_HTML_MAX,
  EMAIL_SEND_TEXT_MAX,
  type WireEmailAdapterExt
} from '@agentconnect.md/protocol'

/** What a reply too long for one mail ends with; the whole answer stays in the session. */
export const EMAIL_REPLY_CUT_MARKER = '[Reply cut: the rest is in the session.]'

const SUBJECT_MAX = 998
const SAFE_HREF = /^(?:https?:\/\/|mailto:)/i

/** The thread's subject with a single `Re:`, however many the answered mail carried. */
export function emailReplySubject(subject: string): string {
  const bare = subject.replace(/^(?:\s*re\s*:)+\s*/i, '').trim()
  return `Re: ${bare}`.trimEnd().slice(0, SUBJECT_MAX)
}

/** The answered mail's chain with its own ID appended, oldest first, cut from the front past the limit. */
export function emailReplyReferences(mail: Pick<WireEmailAdapterExt, 'messageId' | 'references'>): string[] {
  const chain = [...mail.references.filter((id) => id !== mail.messageId), mail.messageId]
  return chain.slice(-EMAIL_REFERENCES_MAX)
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

const escapeAttr = (text: string): string => escapeHtml(text).replace(/"/g, '&quot;')

interface Ctx {
  source: string
  definitions: Map<string, string>
}

// The node's own source, escaped: the fallback for anything with no tag here.
function sourceOf(node: Nodes, ctx: Ctx): string {
  const start = node.position?.start.offset
  const end = node.position?.end.offset
  return start === undefined || end === undefined ? '' : escapeHtml(ctx.source.slice(start, end))
}

function anchor(url: string, label: string): string {
  return SAFE_HREF.test(url) ? `<a href="${escapeAttr(url)}">${label || escapeHtml(url)}</a>` : label || escapeHtml(url)
}

function inline(nodes: readonly Nodes[], ctx: Ctx): string {
  return nodes.map((node) => inlineNode(node, ctx)).join('')
}

function inlineNode(node: Nodes, ctx: Ctx): string {
  switch (node.type) {
    case 'text':
      return escapeHtml(node.value)
    case 'strong':
      return `<strong>${inline(node.children, ctx)}</strong>`
    case 'emphasis':
      return `<em>${inline(node.children, ctx)}</em>`
    case 'delete':
      return `<s>${inline(node.children, ctx)}</s>`
    case 'inlineCode':
      return `<code>${escapeHtml(node.value)}</code>`
    case 'break':
      return '<br>'
    case 'link':
      return anchor(node.url, inline(node.children, ctx))
    // A remote image is a tracking surface in mail, so it is sent as its link.
    case 'image':
      return anchor(node.url, escapeHtml(node.alt ?? ''))
    case 'linkReference':
    case 'imageReference': {
      const url = ctx.definitions.get(node.identifier)
      if (url === undefined) return sourceOf(node, ctx)
      return anchor(url, node.type === 'linkReference' ? inline(node.children, ctx) : escapeHtml(node.alt ?? ''))
    }
    // Raw HTML in the answer is shown as text, never sent as markup.
    case 'html':
      return escapeHtml(node.value)
    default:
      return 'children' in node ? inline(node.children, ctx) : sourceOf(node, ctx)
  }
}

function blocks(nodes: readonly RootContent[], ctx: Ctx): string {
  return nodes
    .filter((node) => node.type !== 'definition')
    .map((node) => block(node, ctx))
    .filter((html) => html.length > 0)
    .join('\n')
}

function block(node: RootContent, ctx: Ctx): string {
  switch (node.type) {
    case 'paragraph':
      return `<p>${inline(node.children, ctx).replace(/\n/g, '<br>\n')}</p>`
    case 'heading':
      return `<h${node.depth}>${inline(node.children, ctx)}</h${node.depth}>`
    case 'thematicBreak':
      return '<hr>'
    case 'code':
      return `<pre><code>${escapeHtml(node.value)}</code></pre>`
    case 'blockquote':
      return `<blockquote>${blocks(node.children, ctx)}</blockquote>`
    case 'list': {
      const tag = node.ordered ? 'ol' : 'ul'
      const start = node.ordered && node.start != null && node.start !== 1 ? ` start="${node.start}"` : ''
      const items = node.children.map((item) => {
        // A tight list's items read as lines, not as paragraphs of their own.
        const body = item.spread
          ? blocks(item.children, ctx)
          : item.children
              .map((child) => (child.type === 'paragraph' ? inline(child.children, ctx) : block(child, ctx)))
              .join('\n')
        return `<li>${body}</li>`
      })
      return `<${tag}${start}>\n${items.join('\n')}\n</${tag}>`
    }
    case 'html':
      return `<p>${escapeHtml(node.value)}</p>`
    default:
      return 'children' in node
        ? `<p>${inline((node as Parents).children as Nodes[], ctx)}</p>`
        : `<p>${sourceOf(node, ctx)}</p>`
  }
}

function collectDefinitions(node: Nodes, into: Map<string, string>): void {
  if (node.type === 'definition') {
    const definition = node as Definition
    if (!into.has(definition.identifier)) into.set(definition.identifier, definition.url)
  }
  if ('children' in node) for (const child of node.children) collectDefinitions(child, into)
}

/** The answer's Markdown as simple HTML: paragraphs, headings, lists, quotes, code and links, with everything else escaped. */
export function emailHtml(markdown: string): string {
  const tree = fromMarkdown(markdown)
  const definitions = new Map<string, string>()
  collectDefinitions(tree, definitions)
  return blocks(tree.children, { source: markdown, definitions })
}

// A cut that would split a surrogate pair moves back one code unit.
function cutAt(text: string, limit: number): string {
  const unit = text.charCodeAt(limit - 1)
  return text.slice(0, limit > 1 && unit >= 0xd800 && unit <= 0xdbff ? limit - 1 : limit)
}

/** One reply's two bodies within the wire's limits: the Markdown as written for a plain-text reader, and its HTML. */
export function emailReplyBodies(markdown: string): { text: string; html: string; cut: boolean } {
  const whole = markdown.trim()
  let text = whole
  if (text.length > EMAIL_SEND_TEXT_MAX)
    text = `${cutAt(text, EMAIL_SEND_TEXT_MAX - EMAIL_REPLY_CUT_MARKER.length - 2).trimEnd()}\n\n${EMAIL_REPLY_CUT_MARKER}`
  let html = emailHtml(text)
  // Markup can outgrow its source past the limit; the text is then sent preformatted, cut again to fit.
  if (html.length > EMAIL_SEND_HTML_MAX || !html) {
    const escaped = escapeHtml(text)
    html = `<pre>${escaped.length > EMAIL_SEND_HTML_MAX - 11 ? escapeHtml(cutAt(text, Math.floor(EMAIL_SEND_HTML_MAX / 6))) : escaped}</pre>`
  }
  return { text, html, cut: text !== whole }
}
