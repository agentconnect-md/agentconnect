import { resolveFileBrowserMarkdownLink } from '@/components/console/file-browser-links'
import type { MarkdownLinkResolution } from '@/components/console/MarkdownView'

const EXPLICIT_SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/

/** Resolve a Markdown href to one flat sibling memory file. */
export function memoryFileFromHref(href: string): string | null {
  const delimiter = href.search(/[?#]/)
  let rawPath = delimiter === -1 ? href : href.slice(0, delimiter)
  if (!rawPath || rawPath.startsWith('/') || rawPath.startsWith('\\') || EXPLICIT_SCHEME_RE.test(rawPath)) {
    return null
  }

  // A literal ./ is the only path prefix supported by the flat memory viewer.
  // Strip it before decoding so encoded separators remain rejectable below.
  if (rawPath.startsWith('./')) rawPath = rawPath.slice(2)

  let name: string
  try {
    name = decodeURIComponent(rawPath)
  } catch {
    return null
  }

  if (!name || name.includes('/') || name.includes('\\') || name.includes('\0') || !name.endsWith('.md')) {
    return null
  }
  return name
}

/** Apply the shared file-browser link behavior with memory's flat `.md` policy. */
export function resolveMemoryMarkdownLink(
  href: string,
  onOpen: (name: string) => void
): MarkdownLinkResolution | undefined {
  return resolveFileBrowserMarkdownLink(
    href,
    (candidate) => {
      const name = memoryFileFromHref(candidate)
      return name ? { path: name, name } : null
    },
    (target) => onOpen(target.name)
  )
}
