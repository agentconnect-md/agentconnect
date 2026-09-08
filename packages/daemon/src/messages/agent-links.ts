import { fromMarkdown } from 'mdast-util-from-markdown'
import type { Definition, Nodes } from 'mdast'

const WEB_SCHEME = /^(?:https?|mailto):/i
const HOST_ABSOLUTE = /^(?:[\\/]|[A-Za-z]:[\\/]|file:)/i

export interface FlattenOptions {
  /** Keep a relative target linked: a code host resolves it against the repository, chat cannot. */
  resolvesRelativeTargets?: boolean
}

/** Rewrite unsafe link targets without reformatting the rest of the Markdown source. */
export function flattenUnsafeLinks(text: string, opts: FlattenOptions = {}): string {
  if (!text.includes('[') && !text.includes('<')) return text
  const tree = fromMarkdown(text)
  const definitions = new Map<string, Definition>()
  const index = (node: Nodes): void => {
    // CommonMark resolves every reference against the first definition with that identifier.
    if (node.type === 'definition' && !definitions.has(node.identifier)) definitions.set(node.identifier, node)
    if ('children' in node) node.children.forEach(index)
  }
  index(tree)

  const keeps = (url: string): boolean =>
    WEB_SCHEME.test(url) || (opts.resolvesRelativeTargets === true && !HOST_ABSOLUTE.test(url))

  const render = (node: Nodes): string => {
    const start = node.position!.start.offset!
    const end = node.position!.end.offset!
    if (node.type === 'definition') return keeps(node.url) ? text.slice(start, end) : ''

    let cursor = start
    let content = ''
    let label = ''
    if ('children' in node) {
      const children = node.children.map((child) => ({ child, rendered: render(child) }))
      const changed = children.some(
        ({ child, rendered }) => rendered !== text.slice(child.position!.start.offset!, child.position!.end.offset!)
      )
      for (const { child, rendered: result } of children) {
        // Literal syntax beside a rewritten link must not become an active outer link on the platform.
        const rendered = changed && child.type === 'text' ? escapeLiteralLinkSyntax(result) : result
        content += text.slice(cursor, child.position!.start.offset!) + rendered
        label += rendered
        cursor = child.position!.end.offset!
      }
    }
    content += text.slice(cursor, end)

    const target =
      node.type === 'link' || node.type === 'image'
        ? node
        : node.type === 'linkReference' || node.type === 'imageReference'
          ? definitions.get(node.identifier)
          : undefined
    if (!target || keeps(target.url)) return content

    const display = target.url.startsWith('#') ? '' : HOST_ABSOLUTE.test(target.url) ? basename(target.url) : target.url
    // Images have no useful visible label here; an autolink's label is the unsafe target itself.
    const visible = (node.type === 'link' && text[start] === '[') || node.type === 'linkReference' ? label : ''
    if (!display || visible.includes(display)) return visible || inlineCode(display)
    return visible ? `${visible} (${inlineCode(display)})` : inlineCode(display)
  }
  return render(tree)
}

/** Escape both bracket sides so literal text cannot open or prematurely close a surrounding link. */
function escapeLiteralLinkSyntax(text: string): string {
  return text.replace(/\\.|[<[\]]/g, (token) => (token.length === 1 ? `\\${token}` : token))
}

/** Hold a whole Markdown block when later definitions could still change its references. */
export function referenceBufferStart(text: string): number | undefined {
  if (!text.includes('[')) return undefined
  const needsDefinitions = (node: Nodes): boolean => {
    if (node.type === 'definition' || node.type === 'linkReference' || node.type === 'imageReference') return true
    if (node.type === 'text') return node.value.includes('[')
    return 'children' in node && node.children.some(needsDefinitions)
  }
  return fromMarkdown(text).children.find(needsDefinitions)?.position?.start.offset
}

/** Last path segment of a host path, in either separator, ignoring trailing slashes. */
function basename(path: string): string {
  const trimmed = path.replaceAll('\\', '/').replace(/\/+$/, '')
  return trimmed.slice(trimmed.lastIndexOf('/') + 1) || trimmed
}

/** A decoded destination may contain backticks, so quote it with a longer code delimiter. */
function inlineCode(value: string): string {
  const width = (value.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0) + 1
  const fence = '`'.repeat(width)
  const padded = value.startsWith('`') || value.endsWith('`') || (value.startsWith(' ') && value.endsWith(' '))
  return `${fence}${padded ? ` ${value} ` : value}${fence}`
}
