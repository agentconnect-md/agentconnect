import { posix, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'

export type WorkspaceFileLinkResolver = (target: string) => string | undefined

export interface WorkspaceFileLinkContext {
  sessionUrl: string
  agentId: string
  cwd: string
  roots: readonly { path: string; repo?: string }[]
}

const WINDOWS_PATH = /^(?:[A-Za-z]:[\\/]|\\\\)/

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
  return (target) => {
    if (!target || /^[#?]/.test(target)) return undefined
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
    for (const root of roots) {
      const relative = paths.relative(root.path, absolute)
      if (!relative || paths.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${paths.sep}`))
        continue
      const segments = relative.split(paths.sep)
      if (relative.split(/[\\/]/).some((segment) => segment.toLowerCase() === '.git')) return undefined
      const url = new URL(session)
      url.hash = ''
      url.searchParams.set('view', 'flat')
      url.searchParams.set('agent', ctx.agentId)
      url.searchParams.set('file', segments.join('/'))
      url.searchParams.delete('mode')
      if (root.repo) url.searchParams.set('repo', root.repo)
      else url.searchParams.delete('repo')
      return url.href
    }
    return undefined
  }
}
