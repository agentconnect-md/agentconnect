'use client'

// Live workspace file browser for one agent — modelled on GitHub's file explorer:
// a single workspace card up top, an expandable directory tree on the left, and
// a file preview on the right. Listings and file bytes are proxied through the CP
// straight from the owning daemon (never stored on the CP — body-locality), so a
// 503 here just means that daemon is offline / the agent is unplaced — an expected
// state, rendered as a friendly notice.
//
// This component owns the live git read model (status / pull) but not the card
// that displays it: it projects that state into a <WorkspaceHeaderInfo> and hands
// it to `renderHeader`, so the workspace card can also carry the source and
// repository-authorization controls, which need agent-level data this component
// has no business fetching. Demo agents use <WorkspaceFilesMock>.

import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import dynamic from 'next/dynamic'
import {
  ApiError,
  fetchWorkspaceFile,
  fetchWorkspaceFileFull,
  fetchWorkspaceFiles,
  fetchWorkspaceGitStatus,
  writeWorkspaceFile,
  workspaceGitPull,
  type WorkspaceEntryDto,
  type WorkspaceFileDto,
  type WorkspaceGitStatusDto
} from '@/lib/api'
import { Spinner } from '@/components/marks'
import { Button, Icon } from '@/components/ui'
import { useIsMobile } from '@/lib/use-is-mobile'
import { escapeHtml, highlight, linkifyHtml, loadHljs } from '@/lib/highlight'
import { resolveWorkspaceMarkdownLink } from '@/components/console/workspace-links'
import type { WorkspaceHeaderInfo } from '@/components/console/WorkspaceCard'
import type { Agent } from '@/lib/data'
import type { MarkdownLinkResolution } from '@/components/console/MarkdownView'
import {
  FileBrowserLayout,
  FileBrowserPreviewHeader,
  FileBrowserRow,
  FileBrowserShell,
  MARKDOWN_FILE_RE,
  fileBrowserGlyph
} from '@/components/console/FileBrowser'

// react-markdown + remark-gfm are heavy and only needed when a markdown file is
// previewed, so keep them out of the main console bundle (lazy client chunk).
const MarkdownView = dynamic(() => import('@/components/console/MarkdownView'), {
  ssr: false,
  loading: () => (
    <div className="px-[18px] py-4 font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
      Rendering…
    </div>
  )
})

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))

/**
 * Identity of the daemon-local checkout one <WorkspaceFiles> instance reads.
 *
 * The tree, the open preview and the git status are fetched per agent and then
 * cached in component state keyed only on `agentId`, so a workspace REPLACEMENT
 * (mode / repo / branch / working subdirectory) has to remount the instance
 * rather than reuse it. Since the workspace editor now lives in the card above
 * the browser — same tab, same mounted tree — reuse would leave the refreshed
 * source card sitting on top of files that belong to the workspace it replaced,
 * and a GitHub → scratch conversion would additionally flip `canEdit` to true
 * over that stale GitHub preview. Pass this as the instance's React `key`.
 */
export function workspaceReadModelKey(agent: Pick<Agent, 'id' | 'workspace' | 'workdir'>): string {
  const ws = agent.workspace
  const at = `${agent.id}:${agent.workdir}`
  return ws.mode === 'github' ? `${at}:github:${ws.repo}@${ws.branch}:${ws.agentDir}` : `${at}:scratch`
}

function entryIcon(e: WorkspaceEntryDto): string {
  if (e.type === 'dir') return 'folder'
  if (e.type === 'symlink') return 'link-2'
  if (e.type === 'other') return 'file-question-mark'
  return fileBrowserGlyph(e.name)
}

function fmtBytes(n: number | null): string {
  if (n == null) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

// Relative when recent (matches the fleet's "last seen" feel), short date otherwise.
function fmtMtime(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const ms = Date.now() - d.getTime()
  const s = Math.round(ms / 1000)
  if (!Number.isFinite(s) || s < 0) return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const dd = Math.floor(h / 24)
  if (dd < 7) return `${dd}d ago`
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

// Parse a full git remote address (https or ssh) into a display label ("org/repo")
// and a browsable https URL. Returns null when it doesn't look like a hosted repo.
function parseRemote(repo: string | null): { label: string; host: string; url: string } | null {
  if (!repo) return null
  const m = repo.match(/^https?:\/\/([^/]+)\/(.+?)(?:\.git)?\/?$/) ?? repo.match(/^git@([^:]+):(.+?)(?:\.git)?\/?$/)
  if (!m) return null
  return { host: m[1]!, label: m[2]!, url: `https://${m[1]}/${m[2]}` }
}

// A one-letter git status for the tree badge, coloured GitHub-style: modified/renamed
// amber, added/untracked green, deleted red.
function statusMeta(ch: string): { color: string; title: string } {
  switch (ch) {
    case 'A':
    case 'U':
      return { color: 'var(--green-500)', title: ch === 'U' ? 'Untracked' : 'Added' }
    case 'D':
      return { color: 'var(--red-500)', title: 'Deleted' }
    case 'R':
      return { color: 'var(--amber-500)', title: 'Renamed' }
    default:
      return { color: 'var(--amber-500)', title: 'Modified' }
  }
}

// Per-directory listing state, keyed by directory path ('' = workspace root). Loaded
// lazily: the root on mount, each folder on first expand.
type DirState = {
  entries: WorkspaceEntryDto[] | null
  exists: boolean
  nextCursor: string | null
  loading: boolean
  loadingMore: boolean
  err: string | null
  moreErr: string | null
}
const LOADING_DIR: DirState = {
  entries: null,
  exists: true,
  nextCursor: null,
  loading: true,
  loadingMore: false,
  err: null,
  moreErr: null
}

type Viewer = {
  path: string
  name: string
  loading: boolean
  err: string | null // initial-load failure
  moreErr: string | null // append (Load more) failure — keeps already-loaded content
  file: WorkspaceFileDto | null // latest slice (carries nextOffset/truncated)
  content: string // accumulated slices
  loadingMore: boolean
}

type EditorDraft = {
  target: string // '' creates; an existing path edits in place
  directory: string
  name: string
  content: string
  mtime: string | null
  loading: boolean
  saving: boolean
  error: string | null
}

export function WorkspaceFiles({
  agentId,
  workdir,
  canEdit,
  renderHeader
}: {
  agentId: string
  workdir?: string
  canEdit: boolean
  /** Renders the workspace card above the tree from the live git read model.
   *  Called on every render — including before the status lands (empty info) and
   *  for non-repo workspaces — so the card's own controls are never gated on a
   *  daemon round-trip. */
  renderHeader: (header: WorkspaceHeaderInfo) => ReactNode
}) {
  const isMobile = useIsMobile()
  const [dirs, setDirs] = useState<Record<string, DirState>>({})
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [viewer, setViewer] = useState<Viewer | null>(null)
  const [editor, setEditor] = useState<EditorDraft | null>(null)
  const [mobileListSignal, setMobileListSignal] = useState(0)
  // git-repo workspaces: current-checkout status + on-demand pull. Null while
  // loading, for a non-repo workspace, and when the owning daemon is offline —
  // the workspace card falls back to the agent's configured source in all three.
  const [git, setGit] = useState<WorkspaceGitStatusDto | null>(null)
  const [gitPulling, setGitPulling] = useState(false)
  const [gitMsg, setGitMsg] = useState<string | null>(null)
  // Bumped after a pull to re-fetch both the git status and the tree.
  const [refreshTick, setRefreshTick] = useState(0)
  // One-shot: on first entry, auto-preview the project guide (CLAUDE.md / README.md).
  const autoOpenedRef = useRef(false)
  // A path check alone cannot distinguish A → B → A requests. Sequence every file
  // read so an older response can never replace or append to a newer selection.
  const viewerRequestRef = useRef(0)

  // Patch one directory's state, seeding from LOADING_DIR when first seen.
  const patchDir = (path: string, patch: Partial<DirState>) =>
    setDirs((prev) => ({ ...prev, [path]: { ...(prev[path] ?? LOADING_DIR), ...patch } }))

  // Fetch a folder's first page (root on mount, or a folder on first expand).
  const loadDir = (path: string) => {
    patchDir(path, { loading: true, err: null })
    fetchWorkspaceFiles(agentId, { path }).then(
      (page) =>
        setDirs((prev) => ({
          ...prev,
          [path]: {
            entries: page.entries,
            exists: page.exists,
            nextCursor: page.nextCursor,
            loading: false,
            loadingMore: false,
            err: null,
            moreErr: null
          }
        })),
      (e) => patchDir(path, { loading: false, err: msg(e) })
    )
  }

  const loadMoreDir = (path: string) => {
    const d = dirs[path]
    if (!d?.nextCursor || d.loadingMore) return
    patchDir(path, { loadingMore: true, moreErr: null })
    fetchWorkspaceFiles(agentId, { path, cursor: d.nextCursor }).then(
      (page) =>
        setDirs((prev) => {
          const cur = prev[path]
          if (!cur) return prev
          return {
            ...prev,
            [path]: {
              ...cur,
              entries: [...(cur.entries ?? []), ...page.entries],
              nextCursor: page.nextCursor,
              loadingMore: false
            }
          }
        }),
      (e) => patchDir(path, { loadingMore: false, moreErr: msg(e) })
    )
  }

  const toggleDir = (path: string) => {
    const willOpen = !expanded.has(path)
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
    if (willOpen && !dirs[path]) loadDir(path)
  }

  // Select a file into the right-hand preview pane (fetch its first slice).
  const selectFile = (filePath: string, name: string) => {
    // Any explicit selection supersedes the desktop-only default preview,
    // including a mobile selection carried across a breakpoint change.
    autoOpenedRef.current = true
    const requestId = ++viewerRequestRef.current
    setViewer({
      path: filePath,
      name,
      loading: true,
      err: null,
      moreErr: null,
      file: null,
      content: '',
      loadingMore: false
    })
    fetchWorkspaceFile(agentId, { path: filePath }).then(
      (f) =>
        setViewer((v) =>
          requestId === viewerRequestRef.current && v && v.path === filePath
            ? { ...v, loading: false, file: f, content: f.content ?? '' }
            : v
        ),
      (e) =>
        setViewer((v) =>
          requestId === viewerRequestRef.current && v && v.path === filePath ? { ...v, loading: false, err: msg(e) } : v
        )
    )
  }

  const resolveWorkspaceLink = (href: string): MarkdownLinkResolution | undefined => {
    if (!viewer) return undefined
    return resolveWorkspaceMarkdownLink(viewer.path, href, (target) => selectFile(target.path, target.name))
  }

  // Reset the tree and load the root whenever the agent changes or a pull lands.
  useEffect(() => {
    let active = true
    setDirs({ '': { ...LOADING_DIR } })
    setExpanded(new Set())
    fetchWorkspaceFiles(agentId, { path: '' }).then(
      (page) => {
        if (!active) return
        setDirs({
          '': {
            entries: page.entries,
            exists: page.exists,
            nextCursor: page.nextCursor,
            loading: false,
            loadingMore: false,
            err: null,
            moreErr: null
          }
        })
      },
      (e) => {
        if (active) setDirs({ '': { ...LOADING_DIR, loading: false, err: msg(e) } })
      }
    )
    return () => {
      active = false
    }
  }, [agentId, refreshTick])

  // Per-agent view reset (NOT on a refreshTick bump — that would erase the pull
  // message and yank the open file / re-run the one-shot auto-open).
  useEffect(() => {
    viewerRequestRef.current += 1
    setGitMsg(null)
    setViewer(null)
    setEditor(null)
    setMobileListSignal(0)
    autoOpenedRef.current = false
    return () => {
      viewerRequestRef.current += 1
    }
  }, [agentId])

  const editorTarget = editor?.target ?? null

  // Existing files load in full before editing. Creation starts with an empty
  // draft in the directory represented by the breadcrumb.
  useEffect(() => {
    if (!editorTarget) return
    let active = true
    fetchWorkspaceFileFull(agentId, editorTarget).then(
      (file) => {
        if (!active) return
        setEditor((current) => {
          if (!current || current.target !== editorTarget) return current
          return !file.exists || file.encoding !== 'utf8' || !file.mtime
            ? { ...current, loading: false, error: 'Only existing text files can be edited.' }
            : { ...current, content: file.content ?? '', mtime: file.mtime, loading: false }
        })
      },
      (e) => {
        if (active) {
          setEditor((current) =>
            current?.target === editorTarget ? { ...current, loading: false, error: msg(e) } : current
          )
        }
      }
    )
    return () => {
      active = false
    }
  }, [agentId, editorTarget])

  const editorOpen = editor !== null
  const editorSaving = editor?.saving ?? false

  useEffect(() => {
    if (!editorOpen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !editorSaving) setEditor(null)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [editorOpen, editorSaving])

  // git status of the workspace checkout. A non-repo answer and a thrown request
  // (offline daemon) both leave `git` unset — the workspace card then renders the
  // agent's configured source with no live status half.
  useEffect(() => {
    let active = true
    fetchWorkspaceGitStatus(agentId).then(
      (s) => {
        if (active) setGit(s.isRepo ? s : null)
      },
      () => {
        if (active) setGit(null)
      }
    )
    return () => {
      active = false
    }
  }, [agentId, refreshTick])

  // On first entry, preload the project guide so the desktop preview isn't empty.
  // Mobile starts unselected on the shared browser's file list.
  useEffect(() => {
    if (autoOpenedRef.current || isMobile) return
    const root = dirs['']
    if (!root?.entries) return
    autoOpenedRef.current = true
    const guide =
      root.entries.find((e) => e.type === 'file' && e.name.toLowerCase() === 'claude.md') ??
      root.entries.find((e) => e.type === 'file' && e.name.toLowerCase() === 'readme.md')
    if (guide) selectFile(guide.name, guide.name)
  }, [dirs, isMobile])

  // Force a fast-forward pull on the owning daemon, then refresh status + tree.
  const onGitPull = () => {
    if (gitPulling) return
    setGitPulling(true)
    setGitMsg(null)
    workspaceGitPull(agentId).then(
      (r) => {
        setGitPulling(false)
        setGitMsg(r.detail ?? (r.ok ? 'Pulled.' : 'Pull failed.'))
        if (r.ok) setRefreshTick((n) => n + 1)
      },
      () => {
        setGitPulling(false)
        setGitMsg('Pull failed — the daemon may be offline.')
      }
    )
  }

  // Fetch the next slice of the open file and append. The next byte offset is the
  // daemon-supplied nextOffset (never recomputed from decoded content — a multi-byte
  // char split across a slice boundary would make a client recount drift).
  const onViewerMore = () => {
    const v = viewer
    if (!v || v.loadingMore || !v.file?.truncated || v.file.nextOffset == null) return
    const offset = v.file.nextOffset
    const requestId = ++viewerRequestRef.current
    setViewer({ ...v, loadingMore: true, moreErr: null })
    fetchWorkspaceFile(agentId, { path: v.path, offset }).then(
      (f) =>
        setViewer((cur) =>
          requestId === viewerRequestRef.current && cur && cur.path === v.path
            ? { ...cur, loadingMore: false, file: f, content: cur.content + (f.content ?? '') }
            : cur
        ),
      (e) =>
        setViewer((cur) =>
          requestId === viewerRequestRef.current && cur && cur.path === v.path
            ? { ...cur, loadingMore: false, moreErr: msg(e) }
            : cur
        )
    )
  }

  const onFileSaved = (path: string) => {
    setEditor(null)
    setRefreshTick((tick) => tick + 1)
    selectFile(path, path.split('/').at(-1) ?? path)
  }

  // Map browse-relative path → git status letter for the tree badges. git file paths
  // are repo-relative; if the browse root sits in a repo subdir (agentDir), also index
  // the subdir-relative form so badges match whichever root the daemon lists from.
  const dirtyMap = useMemo(() => {
    const m = new Map<string, string>()
    if (!git) return m
    const ad = (git.agentDir ?? '').replace(/^\.?\/*/, '').replace(/\/+$/, '')
    for (const f of git.files) {
      const x = (f.index ?? '').trim()
      const y = (f.workingDir ?? '').trim()
      const ch = x === '?' || y === '?' ? 'U' : (x || y || 'M').charAt(0)
      const put = (p: string) => {
        if (p && !m.has(p)) m.set(p, ch)
      }
      put(f.path)
      if (ad && (f.path === ad || f.path.startsWith(`${ad}/`))) put(f.path.slice(ad.length + 1))
    }
    return m
  }, [git])

  const root = dirs['']
  const selectedDirectory = viewer ? viewer.path.split('/').slice(0, -1).join('/') : ''
  const workspaceRoot = workdir?.replace(/\/+$/, '').split('/').at(-1) || 'Workspace'

  const startCreate = () =>
    setEditor({
      target: '',
      directory: selectedDirectory,
      name: '',
      content: '',
      mtime: null,
      loading: false,
      saving: false,
      error: null
    })

  const startEdit = (path: string) =>
    setEditor({
      target: path,
      directory: path.split('/').slice(0, -1).join('/'),
      name: path.split('/').at(-1) ?? path,
      content: '',
      mtime: null,
      loading: true,
      saving: false,
      error: null
    })

  const closeEditor = () => {
    if (!editor?.saving) setEditor(null)
  }

  const backFromEditor = () => {
    if (editor?.saving) return
    setEditor(null)
    setMobileListSignal((signal) => signal + 1)
  }

  const saveEditor = async () => {
    if (!editor || editor.saving || editor.loading || (editor.target && !editor.mtime)) return
    const creating = editor.target === ''
    const name = editor.name.trim().replace(/^\/+/, '')
    const filePath = creating ? [editor.directory, name].filter(Boolean).join('/') : editor.target
    if (!filePath) {
      setEditor({ ...editor, error: 'Enter a file name or relative path.' })
      return
    }
    setEditor({ ...editor, saving: true, error: null })
    try {
      await writeWorkspaceFile(
        agentId,
        filePath,
        creating ? { content: editor.content } : { content: editor.content, ifMatchMtime: editor.mtime! }
      )
      onFileSaved(filePath)
    } catch (e) {
      setEditor((current) =>
        current?.target === editor.target
          ? {
              ...current,
              saving: false,
              error:
                e instanceof ApiError && e.status === 409
                  ? 'The agent is working or the file changed. Retry when it is idle.'
                  : msg(e)
            }
          : current
      )
    }
  }

  const breadcrumbPath = editor ? editor.target || editor.directory : (viewer?.path ?? '')

  // Recursively render one directory level. Files open in the preview; folders toggle.
  const renderLevel = (dirPath: string, depth: number, openPreview?: () => void): React.ReactNode => {
    const d = dirs[dirPath]
    if (!d) return null
    if (d.loading && !d.entries)
      return (
        <div key={`${dirPath}::spin`} className="py-2 pr-3" style={{ paddingLeft: 12 + depth * 14 }}>
          <Spinner size={15} />
        </div>
      )
    if (d.err && !d.entries)
      return (
        <div
          key={`${dirPath}::err`}
          className="py-[7px] pr-3 font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)"
          style={{ paddingLeft: 12 + depth * 14 }}
        >
          Couldn&apos;t load — the daemon may be offline.
        </div>
      )
    return (
      <>
        {d.entries?.map((e) => {
          const full = dirPath ? `${dirPath}/${e.name}` : e.name
          if (e.type === 'dir') {
            const open = expanded.has(full)
            return (
              <Fragment key={full}>
                <FileBrowserRow
                  depth={depth}
                  chevron={open ? 'chevron-down' : 'chevron-right'}
                  icon={open ? 'folder-open' : 'folder'}
                  name={e.name}
                  onClick={() => toggleDir(full)}
                />
                {open && renderLevel(full, depth + 1, openPreview)}
              </Fragment>
            )
          }
          const meta = [fmtBytes(e.size), fmtMtime(e.mtime)].filter(Boolean).join(' · ')
          const status = dirtyMap.get(full)
          return (
            <FileBrowserRow
              key={full}
              depth={depth}
              icon={entryIcon(e)}
              name={e.name}
              title={meta}
              trailing={status ? <StatusBadge ch={status} /> : undefined}
              selected={viewer?.path === full}
              onClick={
                e.type === 'file'
                  ? () => {
                      selectFile(full, e.name)
                      openPreview?.()
                    }
                  : undefined
              }
            />
          )
        })}
        {d.nextCursor && (
          <div className="flex flex-col gap-1 py-[6px] pr-3" style={{ paddingLeft: 12 + depth * 14 }}>
            <button className="lnk text-[12px]" onClick={() => loadMoreDir(dirPath)}>
              {d.loadingMore ? 'Loading…' : d.moreErr ? 'Retry' : 'Load more'}
            </button>
          </div>
        )}
      </>
    )
  }

  // Project the live git read model onto the workspace card. Nothing here is
  // required: an offline daemon (or a scratch workspace) simply leaves the
  // status/commit/pull half of the card empty.
  const remote = git ? parseRemote(git.repo) : null
  const header: WorkspaceHeaderInfo = {
    branch: git?.branch ?? null,
    status: git
      ? git.clean
        ? { dot: 'var(--status-online)', bg: 'var(--status-online-soft)', text: '#0f7a48', label: 'clean' }
        : {
            dot: 'var(--amber-500)',
            bg: 'var(--status-paused-soft)',
            text: '#9a6500',
            label: `${git.files.length}${git.truncated ? '+' : ''} uncommitted`
          }
      : null,
    commit: git?.lastCommit
      ? {
          sha: git.lastCommit.shortSha,
          time: fmtMtime(git.lastCommit.committedAt),
          title: git.lastCommit.subject
        }
      : null,
    repoUrl: remote?.url ?? null,
    remoteLabel: remote ? (/github/i.test(remote.host) ? 'GitHub' : remote.host) : null,
    ...(git ? { onPull: onGitPull } : {}),
    pulling: gitPulling,
    pullMsg: gitMsg
  }

  return (
    <div className="flex flex-col gap-4">
      {renderHeader(header)}

      <FileBrowserShell
        title={
          <WorkspaceBreadcrumb
            root={workspaceRoot}
            path={breadcrumbPath}
            creating={editor?.target === ''}
            draftName={editor?.name ?? ''}
            onDraftNameChange={(name) =>
              setEditor((current) => (current?.target === '' ? { ...current, name, error: null } : current))
            }
            onBack={isMobile && editor ? backFromEditor : undefined}
            disabled={editor?.saving}
          />
        }
        headerEnd={
          <div className="flex flex-none items-center gap-2">
            {editor ? (
              <>
                <Button variant="secondary" size="xs" onClick={closeEditor} disabled={editor.saving}>
                  Cancel
                </Button>
                <Button
                  size="xs"
                  onClick={() => void saveEditor()}
                  disabled={
                    editor.saving ||
                    editor.loading ||
                    (!!editor.target && !editor.mtime) ||
                    (!editor.target && !editor.name.trim())
                  }
                >
                  {editor.saving ? 'Saving…' : editor.target ? 'Save changes' : 'Create file'}
                </Button>
              </>
            ) : canEdit ? (
              <Button variant="secondary" size="xs" className="flex-none" onClick={startCreate}>
                <Icon name="file-plus" size={13} />
                New file
              </Button>
            ) : null}
          </div>
        }
      >
        {!editor && root?.loading && !root.entries && (
          <div className="flex justify-center py-8">
            <Spinner size={30} />
          </div>
        )}

        {!editor && root?.err && !root.entries && (
          <div className="flex items-start gap-[10px] px-[18px] py-4 font-sans text-[12.5px] font-normal leading-[1.55] text-(--text-secondary)">
            <Icon name="triangle-alert" size={15} color="var(--amber-500)" />
            <span>
              Couldn&apos;t browse the workspace — the owning daemon may be offline. Files live only on that machine and
              are read live from it, so they&apos;re unavailable while it is disconnected.
            </span>
          </div>
        )}

        {!editor && root && !root.loading && !root.err && !root.exists && (
          <EmptyNote text="The workspace has no files yet — the agent creates them as it works." />
        )}

        {root?.entries && root.exists && root.entries.length === 0 && !editor && (
          <EmptyNote text="This workspace is empty." />
        )}

        {(editor || (root?.entries && root.exists && root.entries.length > 0)) && (
          <FileBrowserLayout
            resetKey={`${agentId}:${mobileListSignal}`}
            previewOpen={editor !== null}
            tree={(openPreview) =>
              root?.entries && root.exists && root.entries.length > 0 ? (
                renderLevel('', 0, openPreview)
              ) : (
                <div className="px-3 py-4 text-center font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
                  No files yet.
                </div>
              )
            }
            preview={
              editor
                ? () => (
                    <WorkspaceFileEditor
                      draft={editor}
                      onContentChange={(content) =>
                        setEditor((current) => (current ? { ...current, content, error: null } : current))
                      }
                      onSubmit={() => void saveEditor()}
                    />
                  )
                : viewer
                  ? (onBack) => (
                      <FilePreview
                        key={viewer.path}
                        viewer={viewer}
                        onMore={onViewerMore}
                        resolveLink={resolveWorkspaceLink}
                        onBack={onBack}
                        canEdit={canEdit}
                        onEdit={() => startEdit(viewer.path)}
                      />
                    )
                  : null
            }
          />
        )}
      </FileBrowserShell>
    </div>
  )
}

function EmptyNote({ text }: { text: string }) {
  return (
    <div className="flex flex-col items-center gap-[6px] px-6 py-7 text-center">
      <Icon name="folder" size={20} color="var(--text-tertiary)" />
      <div className="font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">{text}</div>
    </div>
  )
}

function WorkspaceBreadcrumb({
  root,
  path,
  creating,
  draftName,
  onDraftNameChange,
  onBack,
  disabled
}: {
  root: string
  path: string
  creating: boolean
  draftName: string
  onDraftNameChange: (name: string) => void
  onBack?: () => void
  disabled?: boolean
}) {
  const segments = path.split('/').filter(Boolean)

  return (
    <nav className="flex min-w-0 items-center gap-[6px] overflow-hidden" aria-label="Workspace path">
      {onBack ? (
        <button
          type="button"
          className="iconbtn h-7 w-7 flex-none"
          onClick={onBack}
          title="Back to files"
          aria-label="Back to files"
        >
          <Icon name="arrow-left" size={15} />
        </button>
      ) : null}
      <span
        className={`mono max-w-[120px] flex-none truncate text-[12px] font-semibold text-(--text-primary) ${
          segments.length > 0 || creating ? 'max-desktop:hidden' : ''
        }`}
      >
        {root}
      </span>
      {segments.map((segment, index) => {
        const current = !creating && index === segments.length - 1
        return (
          <Fragment key={`${index}:${segment}`}>
            <span className="flex-none text-[12px] font-normal text-(--text-tertiary) max-desktop:hidden" aria-hidden>
              /
            </span>
            <span
              className={`mono min-w-[24px] max-w-[140px] shrink truncate text-[12px] ${
                current ? 'font-semibold text-(--text-primary)' : 'font-medium text-(--text-secondary)'
              } ${current ? '' : 'max-desktop:hidden'}`}
            >
              {segment}
            </span>
          </Fragment>
        )
      })}
      {segments.length === 0 && !creating ? (
        <span className="flex-none text-[12px] font-normal text-(--text-tertiary)" aria-hidden>
          /
        </span>
      ) : null}
      {creating ? (
        <>
          <span className="flex-none text-[12px] font-normal text-(--text-tertiary) max-desktop:hidden" aria-hidden>
            /
          </span>
          <input
            className="inp mono h-7 w-[96px] min-w-16 max-w-full shrink px-2 py-1 text-[12px] desktop:w-[170px] desktop:min-w-[80px] desktop:max-w-[30vw]"
            value={draftName}
            onChange={(event) => onDraftNameChange(event.target.value)}
            placeholder="Name your file…"
            aria-label="New file path"
            spellCheck={false}
            disabled={disabled}
            autoFocus
          />
        </>
      ) : null}
    </nav>
  )
}

export function StatusBadge({ ch }: { ch: string }) {
  const { color, title } = statusMeta(ch)
  return (
    <span
      className="mono inline-flex h-[15px] w-[15px] flex-none items-center justify-center rounded-xs bg-(--surface-sunken) text-[10px] font-bold"
      title={`${title} (uncommitted)`}
      style={{ color }}
    >
      {ch}
    </span>
  )
}

// The right-hand preview pane: a minimal header (icon · name · meta, plus a
// Preview/Code toggle for markdown) then the file body. Markdown renders through
// react-markdown by default (GitHub-style); everything else is syntax-highlighted
// code with bare URLs linkified. Owns the lazy highlight.js pass (loaded only
// when the code view is shown).
function FilePreview({
  viewer,
  onMore,
  resolveLink,
  onBack,
  canEdit,
  onEdit
}: {
  viewer: Viewer
  onMore: () => void
  resolveLink: (href: string) => MarkdownLinkResolution | undefined
  onBack?: () => void
  canEdit: boolean
  onEdit: () => void
}) {
  const isMd = MARKDOWN_FILE_RE.test(viewer.name)
  const [mode, setMode] = useState<'preview' | 'code'>(isMd ? 'preview' : 'code')
  const [html, setHtml] = useState<string | null>(null)
  const isText = viewer.file?.encoding === 'utf8' && viewer.file.exists
  const content = viewer.content
  const showCode = !isMd || mode === 'code'

  useEffect(() => {
    if (!isText || !content || !showCode) {
      setHtml(null)
      return
    }
    let active = true
    loadHljs().then(
      (hljs) => {
        if (active) setHtml(highlight(hljs, content, viewer.name))
      },
      () => {
        if (active) setHtml(null) // highlighter unavailable — plain text is fine
      }
    )
    return () => {
      active = false
    }
  }, [isText, content, showCode, viewer.name])

  // Final code-view HTML: highlighted when hljs is ready (escaped plain text
  // until then / if it fails to load), with bare URLs wrapped into anchors.
  const codeHtml = useMemo(
    () => (isText && showCode && content ? linkifyHtml(html ?? escapeHtml(content)) : null),
    [isText, showCode, content, html]
  )

  const meta = [fmtBytes(viewer.file?.size ?? null), viewer.file?.mtime ? `edited ${fmtMtime(viewer.file.mtime)}` : '']
    .filter(Boolean)
    .join(' · ')

  return (
    <>
      <FileBrowserPreviewHeader
        icon={fileBrowserGlyph(viewer.name)}
        name={viewer.name}
        meta={meta}
        onBack={onBack}
        actions={
          (canEdit && isText && !!viewer.file?.mtime) || (isMd && isText) ? (
            <div className="flex flex-none items-center gap-2">
              {canEdit && isText && viewer.file?.mtime ? (
                <Button variant="secondary" size="xs" onClick={onEdit}>
                  <Icon name="pencil" size={14} />
                  Edit
                </Button>
              ) : null}
              {isMd && isText ? (
                <span className="pillbar flex-none">
                  <button className={mode === 'preview' ? 'pill on' : 'pill'} onClick={() => setMode('preview')}>
                    Preview
                  </button>
                  <button className={mode === 'code' ? 'pill on' : 'pill'} onClick={() => setMode('code')}>
                    Code
                  </button>
                </span>
              ) : null}
            </div>
          ) : undefined
        }
      />

      {viewer.loading && (
        <div className="flex justify-center py-10">
          <Spinner size={30} />
        </div>
      )}

      {!viewer.loading && viewer.err && (
        <div className="flex items-start gap-[10px] p-4 font-sans text-[12.5px] font-normal leading-[1.55] text-(--text-secondary)">
          <Icon name="triangle-alert" size={15} color="var(--amber-500)" />
          <span>Couldn&apos;t read the file — the owning daemon may be offline.</span>
        </div>
      )}

      {!viewer.loading && !viewer.err && viewer.file && !viewer.file.exists && (
        <div className="p-4 font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
          File not found — it may have been removed since the listing.
        </div>
      )}

      {!viewer.loading && !viewer.err && viewer.file?.exists && viewer.file.encoding === 'none' && (
        <div className="flex items-center gap-2 p-4 font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
          <Icon name="file-question-mark" size={15} />
          Binary file — not displayed ({fmtBytes(viewer.file.size)})
        </div>
      )}

      {!viewer.loading && !viewer.err && viewer.file?.exists && viewer.file.encoding === 'utf8' && (
        <>
          {isMd && mode === 'preview' ? (
            <div className="max-h-[520px] overflow-auto px-[18px] py-4">
              <MarkdownView content={content} resolveLink={resolveLink} />
            </div>
          ) : (
            <pre className="hljs mono m-0 max-h-[520px] overflow-auto [word-break:break-word] bg-transparent px-4 py-[14px] text-[12px] leading-[1.7] whitespace-pre-wrap text-(--text-primary)">
              {codeHtml != null ? <code dangerouslySetInnerHTML={{ __html: codeHtml }} /> : <code>{content}</code>}
            </pre>
          )}
          {viewer.file.truncated && (
            <div className="flex items-center gap-[10px] border-t border-(--border-subtle) px-4 pt-[10px] pb-[14px] font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
              <span>
                Showing first {fmtBytes(viewer.file.nextOffset)} of {fmtBytes(viewer.file.size)}
              </span>
              <button className="lnk text-[12px]" onClick={onMore}>
                {viewer.loadingMore ? 'Loading…' : viewer.moreErr ? 'Retry' : 'Load more'}
              </button>
              {viewer.moreErr && (
                <span className="text-(--text-tertiary)">Couldn&apos;t load more — the daemon may be offline.</span>
              )}
            </div>
          )}
        </>
      )}
    </>
  )
}

function WorkspaceFileEditor({
  draft,
  onContentChange,
  onSubmit
}: {
  draft: EditorDraft
  onContentChange: (content: string) => void
  onSubmit: () => void
}) {
  const creating = draft.target === ''

  return (
    <form
      className="flex min-h-[300px] flex-1 flex-col"
      aria-label={creating ? 'New workspace file' : `Edit ${draft.target}`}
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit()
      }}
    >
      {draft.loading ? (
        <div className="flex flex-1 justify-center py-10">
          <Spinner size={28} />
        </div>
      ) : (
        <div className="flex flex-1 flex-col gap-3 p-4">
          {draft.error ? (
            <div className="text-[12.5px] text-(--status-error)" role="alert">
              {draft.error}
            </div>
          ) : null}
          <textarea
            className="inp mono min-h-[390px] flex-1 resize-y items-start justify-start px-3 py-[10px] leading-[1.6] focus:border-(--brand) focus:outline-none"
            value={draft.content}
            onChange={(event) => onContentChange(event.target.value)}
            aria-label={creating ? 'New file content' : `Edit ${draft.target}`}
            spellCheck={false}
            disabled={draft.saving || (!creating && !draft.mtime)}
            autoFocus={!creating}
          />
        </div>
      )}
    </form>
  )
}
