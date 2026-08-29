// A runtime links a file it wrote by its absolute path, clickable in its own UI and nowhere else.
// Delivered as a link that names the daemon's filesystem layout, it is what `startFailureDetail`
// already refuses to do for refusal text — so flatten any target a reader could not follow.

// Only these reach a reader as a working link; every other target is flattened to text.
const WEB_SCHEME = /^(?:https?|mailto):/i
// An in-document anchor has nothing to jump to in a chat message, so it flattens to its label alone.
const FRAGMENT = /^#/
// Host-absolute in both shapes the daemon runs on, plus the `file://` form of the POSIX one.
const HOST_ABSOLUTE = /^(?:\/|[A-Za-z]:[\\/]|file:\/\/)/
// `[label](dest)` / `![alt](src)`, with the optional CommonMark title and `<dest>` bracket form.
const LINK = /(!?)\[([^\[\]]*)\]\(\s*(<[^<>]*>|[^()\s]+)(?:\s+(?:"[^"]*"|'[^']*'|\([^()]*\)))?\s*\)/g
// A fence opens or closes on a line whose first non-space run is >= 3 backticks or tildes.
const FENCE = /^[ \t]*(`{3,}|~{3,})/

export interface FlattenOptions {
  /** Keep a relative target linked: a code host resolves it against the repository, chat cannot. */
  resolvesRelativeTargets?: boolean
}

/** Rewrite every link outside code so a target the reader cannot follow survives as text. */
export function flattenUnsafeLinks(text: string, opts: FlattenOptions = {}): string {
  if (!text.includes('](')) return text
  return mapOutsideCode(text, (segment) =>
    segment.replace(LINK, (whole, bang: string, label: string, rawDest: string) => {
      const dest = rawDest.startsWith('<') ? rawDest.slice(1, -1).trim() : rawDest
      if (WEB_SCHEME.test(dest)) return whole
      if (opts.resolvesRelativeTargets && !HOST_ABSOLUTE.test(dest)) return whole
      const display = FRAGMENT.test(dest) ? '' : HOST_ABSOLUTE.test(dest) ? basename(dest) : dest
      // An image's alt text describes a picture nobody will see, so only its target survives.
      const visible = bang ? '' : label
      if (!display || visible.includes(display)) return visible || `\`${display}\``
      return visible ? `${visible} (\`${display}\`)` : `\`${display}\``
    })
  )
}

/** Last path segment of a host path, in either separator, ignoring trailing slashes. */
function basename(path: string): string {
  const trimmed = path.replaceAll('\\', '/').replace(/\/+$/, '')
  return trimmed.slice(trimmed.lastIndexOf('/') + 1) || trimmed
}

/** Apply `fn` outside fenced blocks: a fenced sample of this syntax is documentation, not a link. */
function mapOutsideCode(text: string, fn: (segment: string) => string): string {
  const out: string[] = []
  let prose: string[] = []
  let fence = ''
  const flushProse = (): void => {
    if (prose.length === 0) return
    out.push(mapOutsideInlineCode(prose.join('\n'), fn))
    prose = []
  }
  for (const line of text.split('\n')) {
    const opener = FENCE.exec(line)?.[1]
    if (fence) {
      out.push(line)
      // A closing fence must be at least as long as the one that opened the block.
      if (opener && opener[0] === fence[0] && opener.length >= fence.length) fence = ''
      continue
    }
    if (opener) {
      flushProse()
      out.push(line)
      fence = opener
      continue
    }
    prose.push(line)
  }
  flushProse()
  return out.join('\n')
}

/** Apply `fn` to the parts of one prose run that sit outside inline code spans. */
function mapOutsideInlineCode(prose: string, fn: (segment: string) => string): string {
  if (!prose.includes('`')) return fn(prose)
  // Odd indices are the captured spans, which pass through untouched.
  return prose
    .split(/(`+[^`]*`+)/g)
    .map((part, index) => (index % 2 === 1 ? part : fn(part)))
    .join('')
}
