// An agent's own HTML for a mail it starts (email-integration.md §6.4), kept to an allowlist so nothing in it fetches, runs or submits.
import { parse, type DefaultTreeAdapterMap } from 'parse5'

type Node = DefaultTreeAdapterMap['node']
type Element = DefaultTreeAdapterMap['element']

const words = (list: string): ReadonlySet<string> => new Set(list.split(' '))

const SAFE_HREF = /^(?:https?:\/\/|mailto:)/i

// Formatting and layout elements a mail client renders without fetching anything.
const ALLOWED = words(
  'a abbr b blockquote br caption center code col colgroup dd del div dl dt em font h1 h2 h3 h4 h5 h6 hr i ins kbd li mark ol p pre q s small span strike strong sub sup table tbody td tfoot th thead tr u ul'
)

// Elements dropped with everything inside them; any other unknown element keeps its children.
const DROPPED = words(
  'audio base button canvas embed form frame frameset head iframe img input link map math meta noscript object option picture script select source style svg template textarea title track video'
)

const VOID = words('br col hr')

const ATTRIBUTES = words(
  'align bgcolor border cellpadding cellspacing class color colspan dir face height lang rowspan size style title valign width'
)

// CSS that can load something: a resource function, an import or a font, a legacy script hook, or an escape that could spell one.
const UNSAFE_CSS =
  /\\|@import|@font-face|@namespace|(?:url|image|image-set|-webkit-image-set|cross-fade|element|src|expression)\s*\(|behavior\s*:|-moz-binding|javascript:/i

/** Whether CSS text is free of anything that fetches or runs; comments are removed first so they cannot split a token. */
export function emailCssIsSafe(css: string): boolean {
  return !UNSAFE_CSS.test(css.replace(/\/\*[\s\S]*?(?:\*\/|$)/g, ''))
}

const escapeText = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const escapeAttr = (text: string): string => escapeText(text).replace(/"/g, '&quot;')

function attributes(element: Element): string {
  let out = ''
  for (const { name, value } of element.attrs) {
    const key = name.toLowerCase()
    const keep =
      key === 'href'
        ? element.tagName === 'a' && SAFE_HREF.test(value.trim())
        : ATTRIBUTES.has(key) && (key !== 'style' || emailCssIsSafe(value))
    if (keep) out += ` ${key}="${escapeAttr(key === 'href' ? value.trim() : value)}"`
  }
  return out
}

function serialize(nodes: readonly Node[]): string {
  let out = ''
  for (const node of nodes) {
    if (node.nodeName === '#text') out += escapeText((node as DefaultTreeAdapterMap['textNode']).value)
    if (!('tagName' in node)) continue
    const tag = node.tagName
    if (DROPPED.has(tag)) continue
    if (!ALLOWED.has(tag)) {
      out += serialize(node.childNodes)
      continue
    }
    out += `<${tag}${attributes(node)}>`
    if (!VOID.has(tag)) out += `${serialize(node.childNodes)}</${tag}>`
  }
  return out
}

function styleSheets(node: Node, into: string[]): void {
  if (!('tagName' in node)) return
  if (node.tagName === 'style') {
    const css = node.childNodes.map((child) => ('value' in child ? child.value : '')).join('')
    if (css.trim() && emailCssIsSafe(css)) into.push(css.replace(/<\/style/gi, ''))
    return
  }
  if (node.tagName === 'template' || node.tagName === 'svg' || node.tagName === 'math') return
  for (const child of node.childNodes) styleSheets(child, into)
}

/** The agent's HTML as a mail document: allowed elements and attributes only, safe links, and style sheets that load nothing; `footer` goes last in the body. */
export function sanitizeEmailHtml(html: string, footer?: string): string {
  const document = parse(html)
  const root = document.childNodes.find((node): node is Element => 'tagName' in node && node.tagName === 'html')
  const body = root?.childNodes.find((node): node is Element => 'tagName' in node && node.tagName === 'body')
  const sheets: string[] = []
  if (root) styleSheets(root, sheets)
  const head = `<meta charset="utf-8">${sheets.map((css) => `<style>${css}</style>`).join('')}`
  const content = body ? serialize(body.childNodes) : ''
  return `<!doctype html><html><head>${head}</head><body>${content}${footer ? `<hr>${footer}` : ''}</body></html>`
}
