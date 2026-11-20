import { posix, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseSessionFileName, sessionFileName, type SessionFileArea } from '@agentconnect.md/protocol'

export type WorkspaceFileLinkResolver = ((target: string) => string | undefined) & {
  /** Replace an absolute path inside a session files area with its `files:` name, so replies never carry a host path (§2.4). */
  rewriteSessionPaths?: (text: string) => string
}

export interface WorkspaceFileLinkContext {
  sessionUrl: string
  agentId: string
  cwd: string
  roots: readonly { path: string; repo?: string }[]
  /** The session's file areas, each by every absolute path that names it (as told to the agent, and canonical). */
  areas?: readonly { area: SessionFileArea; paths: readonly string[] }[]
}

const WINDOWS_PATH = /^(?:[A-Za-z]:[\\/]|\\\\)/

/** One area path followed by the rest of a path: everything up to whitespace, a quote, a bracket or a backtick. */
function areaPathPattern(root: string): RegExp {
  const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(escaped + '(?=[/\\\\])([^\\s`\'"<>()[\\]]*)', 'g')
}

/** Map runtime paths into the existing authenticated viewer; file reads still enforce containment. */
export function createWorkspaceFileLinkResolver(ctx: WorkspaceFileLinkContext): WorkspaceFileLinkResolver {
  const paths = WINDOWS_PATH.test(ctx.cwd) ? win32 : posix
  let session: URL
  try {
    session = new URL(ctx.sessionUrl)
    if (!/^https?:$/.test(session.protocol)) return () => undefined
  } catch {
    return () => undefined
  }
  const roots = [...ctx.roots].sort((a, b) => b.path.length - a.path.length)
  const areas = (ctx.areas ?? []).flatMap(({ area, paths: names }) => names.map((path) => ({ area, path })))
  areas.sort((a, b) => b.path.length - a.path.length)
  const viewerUrl = (file: string, scope: { repo?: string; root?: SessionFileArea }): string => {
    const url = new URL(session)
    url.hash = ''
    url.searchParams.set('view', 'flat')
    url.searchParams.set('agent', ctx.agentId)
    url.searchParams.set('file', file)
    url.searchParams.delete('mode')
    if (scope.repo) url.searchParams.set('repo', scope.repo)
    else url.searchParams.delete('repo')
    if (scope.root) url.searchParams.set('root', scope.root)
    else url.searchParams.delete('root')
    return url.href
  }
  const resolver: WorkspaceFileLinkResolver = (target) => {
    if (!target || /^[#?]/.test(target)) return undefined
    const named = parseSessionFileName(target.split(/[?#]/, 1)[0]!)
    if (named) {
      if (!named.path || named.path.split('/').some((part) => part === '..' || part === '')) return undefined
      return viewerUrl(named.path, { root: named.area })
    }
    let file: string
    try {
      if (/^file:/i.test(target)) {
        file = fileURLToPath(new URL(target), { windows: paths === win32 })
      } else {
        if (/^[A-Za-z][A-Za-z\d+.-]*:/.test(target) && !WINDOWS_PATH.test(target)) return undefined
        file = target.split(/[?#]/, 1)[0]!
        try {
          file = decodeURIComponent(file)
        } catch {
          // A filesystem path can contain a literal percent sign rather than a URL escape.
        }
      }
    } catch {
      return undefined
    }
    // Runtime file citations may carry a line/column; the viewer currently opens the whole file.
    file = file.replace(/:\d+(?::\d+)?$/, '')
    if (!file || /[\u0000-\u001f\u007f]/.test(file)) return undefined
    if (paths === posix && WINDOWS_PATH.test(file)) return undefined
    const absolute = paths.resolve(ctx.cwd, file)
    for (const { area, path } of areas) {
      const relative = paths.relative(path, absolute)
      if (!relative || paths.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${paths.sep}`))
        continue
      return viewerUrl(relative.split(paths.sep).join('/'), { root: area })
    }
    for (const root of roots) {
      const relative = paths.relative(root.path, absolute)
      if (!relative || paths.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${paths.sep}`))
        continue
      const segments = relative.split(paths.sep)
      if (relative.split(/[\\/]/).some((segment) => segment.toLowerCase() === '.git')) return undefined
      return viewerUrl(segments.join('/'), root.repo ? { repo: root.repo } : {})
    }
    return undefined
  }
  if (areas.length) resolver.rewriteSessionPaths = (text) => rewriteSessionPaths(text, areas)
  return resolver
}

/** Replace each absolute area path in `text` with its `files:` name; text without one is returned as is. */
export function rewriteSessionPaths(text: string, areas: readonly { area: SessionFileArea; path: string }[]): string {
  let out = text
  for (const { area, path } of areas) {
    if (!out.includes(path)) continue
    out = out.replace(areaPathPattern(path), (_match, rest: string) =>
      sessionFileName(area, rest.replace(/^[\\/]+/, '').replaceAll('\\', '/'))
    )
  }
  return out
}
