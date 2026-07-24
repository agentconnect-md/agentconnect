import type { MarkdownLinkResolution } from '@/components/console/MarkdownView'

const EXPLICIT_SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/
const WINDOWS_ABSOLUTE_RE = /^[A-Za-z]:[\\/]/

export interface FileBrowserLinkTarget {
  path: string
  name: string
}

/** Shared action / external / blocked decision for Markdown links in file browsers. */
export function resolveFileBrowserMarkdownLink<T extends FileBrowserLinkTarget>(
  href: string,
  parseTarget: (href: string) => T | null,
  onOpen: (target: T) => void,
  canOpen: (target: T) => boolean = () => true
): MarkdownLinkResolution | undefined {
  const target = parseTarget(href)
  if (target) {
    return canOpen(target) ? { kind: 'action', onActivate: () => onOpen(target) } : { kind: 'blocked' }
  }
  if ((href.startsWith('//') || EXPLICIT_SCHEME_RE.test(href)) && !WINDOWS_ABSOLUTE_RE.test(href)) return undefined
  return { kind: 'blocked' }
}
