import type { WorkspaceFile } from '@/lib/data'
import { resolveFileBrowserMarkdownLink, type FileBrowserLinkTarget } from '@/components/console/file-browser-links'
import type { MarkdownLinkResolution } from '@/components/console/MarkdownView'

const EXPLICIT_SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/

export type WorkspaceLinkTarget = FileBrowserLinkTarget

/** Index the static mock workspace tree by both stable path and object identity. */
export function indexWorkspaceFileTree(files: WorkspaceFile[]): {
  byFile: Map<WorkspaceFile, string>
  byPath: Map<string, WorkspaceFile>
} {
  const byFile = new Map<WorkspaceFile, string>()
  const byPath = new Map<string, WorkspaceFile>()
  const visit = (rows: WorkspaceFile[], prefix: string) => {
    for (const file of rows) {
      const path = prefix ? `${prefix}/${file.name}` : file.name
      byFile.set(file, path)
      if (file.children) visit(file.children, path)
      else byPath.set(path, file)
    }
  }
  visit(files, '')
  return { byFile, byPath }
}

/** Resolve a Markdown href relative to the currently previewed workspace file. */
export function workspaceFileFromHref(currentFilePath: string, href: string): WorkspaceLinkTarget | null {
  const current = currentFilePath.split('/')
  if (
    !currentFilePath ||
    currentFilePath.startsWith('/') ||
    current.some((part) => !part || part === '.' || part === '..' || part.includes('\\') || CONTROL_CHAR_RE.test(part))
  ) {
    return null
  }

  const delimiter = href.search(/[?#]/)
  const rawPath = delimiter === -1 ? href : href.slice(0, delimiter)
  if (
    !rawPath ||
    rawPath.startsWith('/') ||
    rawPath.startsWith('\\') ||
    rawPath.endsWith('/') ||
    EXPLICIT_SCHEME_RE.test(rawPath)
  ) {
    return null
  }

  const target = current.slice(0, -1)
  const rawParts = rawPath.split('/')
  let lastPart = ''
  for (const rawPart of rawParts) {
    let part: string
    try {
      part = decodeURIComponent(rawPart)
    } catch {
      return null
    }

    if (part.includes('/') || part.includes('\\') || CONTROL_CHAR_RE.test(part)) return null
    lastPart = part
    if (!part || part === '.') continue
    if (part === '..') {
      if (target.length === 0) return null
      target.pop()
      continue
    }
    target.push(part)
  }

  const name = target.at(-1)
  if (!name || lastPart === '.' || lastPart === '..') return null
  return { path: target.join('/'), name }
}

/** Map one Markdown href to a workspace action, blocked local link, or external anchor fallback. */
export function resolveWorkspaceMarkdownLink(
  currentFilePath: string,
  href: string,
  onOpen: (target: WorkspaceLinkTarget) => void,
  canOpen: (target: WorkspaceLinkTarget) => boolean = () => true
): MarkdownLinkResolution | undefined {
  return resolveFileBrowserMarkdownLink(
    href,
    (candidate) => workspaceFileFromHref(currentFilePath, candidate),
    onOpen,
    canOpen
  )
}
