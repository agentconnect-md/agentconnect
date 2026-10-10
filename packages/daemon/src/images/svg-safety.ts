// Conservative static-SVG admission (webchat-generated-images.md §5): self-contained, inert, renderable only as an image.

export type SvgCheck = { ok: true; width?: number; height?: number } | { ok: false; detail: string }

// Static SVG 1.1/2 element vocabulary; anything else unprefixed is refused rather than guessed about.
const ALLOWED_ELEMENTS = new Set(
  [
    'svg',
    'g',
    'defs',
    'symbol',
    'use',
    'title',
    'desc',
    'metadata',
    'switch',
    'a',
    'path',
    'rect',
    'circle',
    'ellipse',
    'line',
    'polyline',
    'polygon',
    'text',
    'tspan',
    'textpath',
    'tref',
    'image',
    'marker',
    'pattern',
    'clippath',
    'mask',
    'lineargradient',
    'radialgradient',
    'stop',
    'style',
    'filter',
    'view',
    'fedistantlight',
    'fepointlight',
    'fespotlight',
    'feblend',
    'fecolormatrix',
    'fecomponenttransfer',
    'fefunca',
    'fefuncb',
    'fefuncg',
    'fefuncr',
    'fecomposite',
    'feconvolvematrix',
    'fediffuselighting',
    'fedisplacementmap',
    'fedropshadow',
    'feflood',
    'fegaussianblur',
    'feimage',
    'femerge',
    'femergenode',
    'femorphology',
    'feoffset',
    'fespecularlighting',
    'fetile',
    'feturbulence'
  ].map((name) => name.toLowerCase())
)

// Refused under ANY prefix: active content, embedded documents and animation.
const FORBIDDEN_LOCAL_NAMES = new Set([
  'script',
  'foreignobject',
  'iframe',
  'object',
  'embed',
  'audio',
  'video',
  'canvas',
  'animate',
  'animatemotion',
  'animatetransform',
  'animatecolor',
  'set',
  'discard',
  'handler',
  'listener'
])

const XHTML_NAMESPACE = 'http://www.w3.org/1999/xhtml'
const MAX_ELEMENTS = 200_000
const PREDEFINED_ENTITY = /^&(?:amp|lt|gt|quot|apos|#\d{1,7}|#x[0-9a-fA-F]{1,6});/

/** Admit only a self-contained static SVG: no DTD, scripts, handlers, embedded HTML, animation or external references. */
export function checkStaticSvg(bytes: Buffer): SvgCheck {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return { ok: false, detail: 'SVG is not valid UTF-8' }
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  if (/<!DOCTYPE|<!ENTITY|<!ATTLIST|<!ELEMENT/i.test(text))
    return { ok: false, detail: 'SVG declares a DTD or entities' }
  if (/@import/i.test(text)) return { ok: false, detail: 'SVG imports a stylesheet' }
  const external = externalCssUrl(text)
  if (external) return { ok: false, detail: `SVG references an external resource (${external})` }

  let root: { width?: number; height?: number } | undefined
  let elements = 0
  let i = 0
  while (i < text.length) {
    const lt = text.indexOf('<', i)
    if (lt < 0) break
    const between = text.slice(i, lt)
    const amp = badEntity(between)
    if (amp) return { ok: false, detail: `SVG uses an undeclared entity (${amp})` }
    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4)
      if (end < 0) return { ok: false, detail: 'SVG comment is unterminated' }
      i = end + 3
      continue
    }
    if (text.startsWith('<![CDATA[', lt)) {
      const end = text.indexOf(']]>', lt + 9)
      if (end < 0) return { ok: false, detail: 'SVG CDATA is unterminated' }
      i = end + 3
      continue
    }
    if (text.startsWith('<?', lt)) {
      const end = text.indexOf('?>', lt + 2)
      if (end < 0) return { ok: false, detail: 'SVG processing instruction is unterminated' }
      // Only the leading XML declaration; `<?xml-stylesheet …?>` and friends fetch or execute.
      if (root !== undefined || !/^<\?xml\s/.test(text.slice(lt, end + 2)))
        return { ok: false, detail: 'SVG carries a processing instruction' }
      i = end + 2
      continue
    }
    if (text.startsWith('</', lt)) {
      const end = text.indexOf('>', lt + 2)
      if (end < 0) return { ok: false, detail: 'SVG end tag is unterminated' }
      i = end + 1
      continue
    }
    if (text[lt + 1] === '!') return { ok: false, detail: 'SVG carries a markup declaration' }
    const tag = parseStartTag(text, lt)
    if (!tag.ok) return { ok: false, detail: tag.detail }
    if (++elements > MAX_ELEMENTS) return { ok: false, detail: 'SVG has too many elements' }
    const local = localName(tag.name).toLowerCase()
    if (root === undefined && local !== 'svg') return { ok: false, detail: 'SVG root element is not <svg>' }
    if (FORBIDDEN_LOCAL_NAMES.has(local)) return { ok: false, detail: `SVG contains <${tag.name}>` }
    const prefixed = tag.name.includes(':') && !tag.name.toLowerCase().startsWith('svg:')
    if (!prefixed && !ALLOWED_ELEMENTS.has(local))
      return { ok: false, detail: `SVG contains unsupported <${tag.name}>` }
    for (const [name, value] of tag.attributes) {
      const attr = name.toLowerCase()
      const attrLocal = localName(attr)
      if (attrLocal.startsWith('on')) return { ok: false, detail: `SVG has an event handler (${name})` }
      if ((attr === 'xmlns' || attr.startsWith('xmlns:')) && value.trim() === XHTML_NAMESPACE)
        return { ok: false, detail: 'SVG embeds the HTML namespace' }
      if (attrLocal === 'href' || attrLocal === 'src') {
        if (!value.trim().startsWith('#')) return { ok: false, detail: `SVG references an external resource (${name})` }
      }
      const entity = badEntity(value)
      if (entity) return { ok: false, detail: `SVG uses an undeclared entity (${entity})` }
    }
    if (root === undefined) root = rootSize(tag.attributes)
    i = tag.end
  }
  if (root === undefined) return { ok: false, detail: 'SVG has no <svg> element' }
  return { ok: true, ...root }
}

function localName(name: string): string {
  const colon = name.indexOf(':')
  return colon < 0 ? name : name.slice(colon + 1)
}

// Every CSS `url(...)` must point inside the document.
function externalCssUrl(text: string): string | undefined {
  const re = /url\s*\(\s*(['"]?)([^'")]*)/gi
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (!m[2]!.trim().startsWith('#')) return 'url()'
  }
  return undefined
}

function badEntity(segment: string): string | undefined {
  for (let at = segment.indexOf('&'); at >= 0; at = segment.indexOf('&', at + 1)) {
    if (!PREDEFINED_ENTITY.test(segment.slice(at, at + 12))) return segment.slice(at, at + 12).split(/[\s;]/)[0]
  }
  return undefined
}

type StartTag = { ok: true; name: string; attributes: [string, string][]; end: number } | { ok: false; detail: string }

function parseStartTag(text: string, lt: number): StartTag {
  const nameMatch = /^<([A-Za-z_][\w.:-]*)/.exec(text.slice(lt, lt + 256))
  if (!nameMatch) return { ok: false, detail: 'SVG has a malformed tag' }
  const name = nameMatch[1]!
  const attributes: [string, string][] = []
  let i = lt + nameMatch[0].length
  for (;;) {
    while (i < text.length && /\s/.test(text[i]!)) i++
    if (i >= text.length) return { ok: false, detail: `SVG tag <${name}> is unterminated` }
    if (text[i] === '>') return { ok: true, name, attributes, end: i + 1 }
    if (text.startsWith('/>', i)) return { ok: true, name, attributes, end: i + 2 }
    const attr = /^([A-Za-z_][\w.:-]*)\s*=\s*/.exec(text.slice(i, i + 512))
    if (!attr) return { ok: false, detail: `SVG tag <${name}> has a malformed attribute` }
    i += attr[0].length
    const quote = text[i]
    if (quote !== '"' && quote !== "'") return { ok: false, detail: `SVG attribute ${attr[1]} is unquoted` }
    const close = text.indexOf(quote, i + 1)
    if (close < 0) return { ok: false, detail: `SVG attribute ${attr[1]} is unterminated` }
    const value = text.slice(i + 1, close)
    if (value.includes('<')) return { ok: false, detail: `SVG attribute ${attr[1]} contains markup` }
    attributes.push([attr[1]!, value])
    i = close + 1
  }
}

function rootSize(attributes: [string, string][]): { width?: number; height?: number } {
  const get = (key: string) => attributes.find(([name]) => name === key)?.[1]
  const length = (raw: string | undefined) => {
    const m = raw ? /^\s*(\d+(?:\.\d+)?)\s*(?:px)?\s*$/.exec(raw) : null
    const n = m ? Math.round(Number(m[1])) : NaN
    return n > 0 && n <= 65_535 ? n : undefined
  }
  let width = length(get('width'))
  let height = length(get('height'))
  const viewBox = get('viewBox')
    ?.trim()
    .split(/[\s,]+/)
    .map(Number)
  if ((width === undefined || height === undefined) && viewBox?.length === 4 && viewBox.every(Number.isFinite)) {
    width ??= viewBox[2]! > 0 ? Math.min(65_535, Math.round(viewBox[2]!)) || undefined : undefined
    height ??= viewBox[3]! > 0 ? Math.min(65_535, Math.round(viewBox[3]!)) || undefined : undefined
  }
  return { ...(width ? { width } : {}), ...(height ? { height } : {}) }
}
