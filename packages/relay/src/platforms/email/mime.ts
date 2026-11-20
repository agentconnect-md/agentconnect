// The relay's MIME reader (email-integration.md §5.4, §7): one raw message to the shape the pure normalizer takes, keeping header order and no attachment bytes.
import PostalMime, { addressParser, decodeWords } from 'postal-mime'
import type { EmailHeader, EmailInboundMessage, EmailParsedMailbox } from '@agentconnect.md/message'

// Elements whose content is never text the sender wrote for a reader.
const HIDDEN = new Set(['head', 'script', 'style', 'title', 'template'])
// Elements that start and end a line of their own.
const BLOCK =
  /^(?:address|article|aside|blockquote|dd|div|dl|dt|footer|h[1-6]|header|hr|li|main|ol|p|pre|section|table|tr|ul)$/
// Blocks set apart from their neighbours by an empty line.
const PARAGRAPH = /^(?:p|h[1-6]|blockquote|pre|table)$/
const ENTITIES: Record<string, string> = {
  amp: '&',
  apos: "'",
  bull: '•',
  copy: '©',
  gt: '>',
  hellip: '…',
  ldquo: '“',
  lsquo: '‘',
  lt: '<',
  mdash: '—',
  nbsp: ' ',
  ndash: '–',
  quot: '"',
  rdquo: '”',
  reg: '®',
  rsquo: '’',
  trade: '™'
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z][a-z0-9]{1,15});/gi, (whole, name: string) => {
    if (name[0] !== '#') return ENTITIES[name.toLowerCase()] ?? whole
    const code =
      name[1]!.toLowerCase() === 'x' ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10)
    return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : whole
  })
}

/** An HTML body as the text a reader would see, in one pass over the input: blocks become lines, a link keeps its target, and markup, scripts and styles are dropped. */
export function emailHtmlToText(html: string): string {
  const tagStart = /\/?[a-z]/iy
  // The output in pieces, with its last character beside it: reading a string back while it grows would copy it each time.
  const out: string[] = []
  let last = ''
  // Line breaks owed before the next text: one after a block, two after a paragraph, however many elements asked.
  let owed = 0
  // Text goes out behind the breaks it is owed and never as two spaces in a row, so the output needs no second pass.
  const write = (text: string) => {
    const kept = owed > 0 || last === '' || last === ' ' ? text.replace(/^ /, '') : text
    if (!kept) return
    // A line never ends in the space that stood before its break.
    if (owed > 0 && last === ' ') out[out.length - 1] = out.at(-1)!.slice(0, -1)
    if (last) out.push('\n'.repeat(owed))
    owed = 0
    out.push(kept)
    last = kept.at(-1)!
  }
  let href: string | undefined
  // Where the open link's own text starts in `out`.
  let linkFrom = 0
  let at = 0
  while (at < html.length) {
    const lt = html.indexOf('<', at)
    // Source line breaks are spaces in HTML; only an element breaks a line.
    write(decodeEntities(html.slice(at, lt < 0 ? html.length : lt)).replace(/\s+/g, ' '))
    if (lt < 0) break
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4)
      if (end < 0) break
      at = end + 3
      continue
    }
    tagStart.lastIndex = lt + 1
    // A `<` that opens no tag is text, and is never scanned past, which keeps the pass linear.
    if (html[lt + 1] !== '!' && html[lt + 1] !== '?' && !tagStart.test(html)) {
      write('<')
      at = lt + 1
      continue
    }
    const gt = html.indexOf('>', lt + 1)
    if (gt < 0) break
    const tag = html.slice(lt + 1, gt)
    const closing = tag.startsWith('/')
    const name = /^\/?([a-z][a-z0-9]*)/i.exec(tag)?.[1]?.toLowerCase() ?? ''
    at = gt + 1
    if (!closing && HIDDEN.has(name)) {
      const close = new RegExp(`</${name}`, 'gi')
      close.lastIndex = at
      const found = close.exec(html)
      const end = found ? html.indexOf('>', found.index) : -1
      if (end < 0) break
      at = end + 1
    } else if (name === 'br') owed = Math.min(2, owed + 1)
    else if (name === 'td' || name === 'th') write(closing ? ' ' : '')
    else if (name === 'a') {
      if (!closing) {
        href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/i
          .exec(tag)
          ?.slice(1)
          .find((value) => value !== undefined)
        linkFrom = out.length
      } else if (href !== undefined) {
        const target = decodeEntities(href).trim()
        const shown = out.slice(linkFrom).join('').trim()
        // A link whose text is already its target is written once.
        if (/^(?:https?:|mailto:)/i.test(target) && shown !== target && shown !== target.replace(/^mailto:/i, ''))
          write(owed === 0 && last !== '' && last !== ' ' ? ` (${target})` : `(${target})`)
        href = undefined
      }
    } else if (BLOCK.test(name)) {
      owed = Math.max(owed, PARAGRAPH.test(name) ? 2 : 1)
      if (name === 'li' && !closing) write('- ')
    }
  }
  return out.join('').trimEnd()
}

// Every mailbox one address header names, groups flattened; an entry with no address keeps its name, so it is still counted.
function mailboxes(headers: readonly EmailHeader[], name: string): EmailParsedMailbox[] {
  return headers
    .filter((header) => header.name === name)
    .flatMap((header) => addressParser(header.value, { flatten: true }))
    .map((entry) => ({
      ...(entry.address ? { address: entry.address } : {}),
      ...(entry.name ? { name: entry.name } : {})
    }))
}

/** Parse one raw message as far as it goes; `truncated` marks one the ingress Worker cut (§7). Rejects for a message the parser refuses. */
export async function readEmailMime(raw: Uint8Array, truncated = false): Promise<EmailInboundMessage> {
  const parsed = await PostalMime.parse(raw)
  // Names are lower-cased and values unfolded, in the order the message carried them; only `Subject` is decoded, since every other field read from here is structural.
  const headers: EmailHeader[] = parsed.headers.map(({ key, value }) => ({
    name: key,
    value: key === 'subject' ? decodeWords(value) : value
  }))
  const text = parsed.text ?? (parsed.html === undefined ? undefined : emailHtmlToText(parsed.html))
  return {
    headers,
    from: mailboxes(headers, 'from'),
    to: mailboxes(headers, 'to'),
    cc: mailboxes(headers, 'cc'),
    ...(text === undefined ? {} : { text }),
    // Only the descriptor leaves this function, so the bytes are released with the parse.
    attachments: parsed.attachments.map(({ filename, mimeType, content }) => ({
      ...(filename ? { name: filename } : {}),
      type: mimeType,
      size: typeof content === 'string' ? Buffer.byteLength(content) : content.byteLength
    })),
    ...(truncated ? { truncated: true } : {})
  }
}
