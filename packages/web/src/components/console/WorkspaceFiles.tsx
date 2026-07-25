'use client'

// Live workspace file browser for one agent — modelled on GitHub's file explorer:
// a single repo/status card up top, an expandable directory tree on the left, and
// a file preview on the right. Listings and file bytes are proxied through the CP
// straight from the owning daemon (never stored on the CP — body-locality), so a
// 503 here just means that daemon is offline / the agent is unplaced — an expected
// state, rendered as a friendly notice.
//
// This component owns the whole workspace surface for a live agent (repo card +
// Files card); the parent just mounts it. Demo agents use <WorkspaceFilesMock>.

import { Fragment, useEffect, useId, useMemo, useRef, useState } from 'react'
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
import { GithubMark, Spinner } from '@/components/marks'
import { Button, Icon } from '@/components/ui'
import { useIsMobile } from '@/lib/use-is-mobile'
import { escapeHtml, highlight, linkifyHtml, loadHljs } from '@/lib/highlight'
import { resolveWorkspaceMarkdownLink } from '@/components/console/workspace-links'
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

export function WorkspaceFiles({ agentId, workdir, canEdit }: { agentId: string; workdir?: string; canEdit: boolean }) {
  const isMobile = useIsMobile()
  const [dirs, setDirs] = useState<Record<string, DirState>>({})
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [viewer, setViewer] = useState<Viewer | null>(null)
  const [editPath, setEditPath] = useState<string | null>(null) // '' creates; a path replaces
  // git-repo workspaces: current-checkout status + on-demand pull. `scratch` is set
  // only on a successful non-repo response — an offline daemon leaves both unset so
  // we don't mislabel a repo as scratch.
  const [git, setGit] = useState<WorkspaceGitStatusDto | null>(null)
  const [scratch, setScratch] = useState(false)
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
    setEditPath(null)
    autoOpenedRef.current = false
    return () => {
      viewerRequestRef.current += 1
    }
  }, [agentId])

  // git status of the workspace checkout. A thrown request (offline daemon) leaves
  // both git and scratch unset → no top card; a clean non-repo answer → scratch card.
  useEffect(() => {
    let active = true
    fetchWorkspaceGitStatus(agentId).then(
      (s) => {
        if (!active) return
        if (s.isRepo) {
          setGit(s)
          setScratch(false)
        } else {
          setGit(null)
          setScratch(true)
        }
      },
      () => {
        if (!active) return
        setGit(null)
        setScratch(false)
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
    setEditPath(null)
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
  // Header count + path follow the tree selection: the open file's workspace-
  // relative path (root shows as '/'), counted against its containing directory.
  // Hovering reveals the daemon-absolute workdir (dropped from the line itself).
  const selDir = viewer ? viewer.path.split('/').slice(0, -1).join('/') : ''
  const selCtx = dirs[selDir]
  const selCount = selCtx?.entries?.length
  const summary = root?.entries
    ? `${
        selCount != null ? `${selCount}${selCtx?.nextCursor ? '+' : ''} item${selCount === 1 ? '' : 's'} · ` : ''
      }/${viewer?.path ?? ''}`
    : (workdir ?? '')

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

  return (
    <div className="flex flex-col gap-4">
      {git ? (
        <RepoCard git={git} pulling={gitPulling} msg={gitMsg} onPull={onGitPull} />
      ) : scratch ? (
        <ScratchCard workdir={workdir} />
      ) : null}

      <FileBrowserShell
        title="Files"
        headerEnd={
          <div className="flex min-w-0 items-center gap-2">
            {summary ? (
              <span className="mono truncate text-[11px] text-(--text-tertiary)" title={workdir}>
                {summary}
              </span>
            ) : null}
            {canEdit ? (
              <Button
                variant="secondary"
                size="xs"
                className="flex-none"
                onClick={() => setEditPath('')}
                disabled={editPath !== null}
              >
                <Icon name="file-plus" size={13} />
                New file
              </Button>
            ) : null}
          </div>
        }
      >
        {root?.loading && !root.entries && (
          <div className="flex justify-center py-8">
            <Spinner size={30} />
          </div>
        )}

        {root?.err && !root.entries && (
          <div className="flex items-start gap-[10px] px-[18px] py-4 font-sans text-[12.5px] font-normal leading-[1.55] text-(--text-secondary)">
            <Icon name="triangle-alert" size={15} color="var(--amber-500)" />
            <span>
              Couldn&apos;t browse the workspace — the owning daemon may be offline. Files live only on that machine and
              are read live from it, so they&apos;re unavailable while it is disconnected.
            </span>
          </div>
        )}

        {root && !root.loading && !root.err && !root.exists && (
          <EmptyNote text="The workspace has no files yet — the agent creates them as it works." />
        )}

        {root?.entries && root.exists && root.entries.length === 0 && <EmptyNote text="This workspace is empty." />}

        {root?.entries && root.exists && root.entries.length > 0 && (
          <FileBrowserLayout
            resetKey={agentId}
            tree={(openPreview) => renderLevel('', 0, openPreview)}
            preview={
              viewer
                ? (onBack) => (
                    <FilePreview
                      key={viewer.path}
                      viewer={viewer}
                      onMore={onViewerMore}
                      resolveLink={resolveWorkspaceLink}
                      onBack={onBack}
                      canEdit={canEdit}
                      onEdit={() => setEditPath(viewer.path)}
                    />
                  )
                : null
            }
          />
        )}
      </FileBrowserShell>
      {editPath !== null && (
        <WorkspaceFileEditor
          agentId={agentId}
          editPath={editPath}
          onClose={() => setEditPath(null)}
          onSaved={onFileSaved}
        />
      )}
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
  agentId,
  editPath,
  onClose,
  onSaved
}: {
  agentId: string
  editPath: string
  onClose: () => void
  onSaved: (path: string) => void
}) {
  const creating = editPath === ''
  const titleId = useId()
  const [path, setPath] = useState(editPath)
  const [content, setContent] = useState('')
  const [mtime, setMtime] = useState<string | null>(null)
  const [loading, setLoading] = useState(!creating)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (creating) return
    let active = true
    fetchWorkspaceFileFull(agentId, editPath).then(
      (file) => {
        if (!active) return
        if (!file.exists || file.encoding !== 'utf8' || !file.mtime) {
          setError('Only existing text files can be edited.')
        } else {
          setContent(file.content ?? '')
          setMtime(file.mtime)
        }
        setLoading(false)
      },
      (e) => {
        if (active) {
          setError(msg(e))
          setLoading(false)
        }
      }
    )
    return () => {
      active = false
    }
  }, [agentId, creating, editPath])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !saving) onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose, saving])

  const save = async () => {
    const filePath = path.trim()
    if (!filePath) {
      setError('Enter a workspace-relative file path.')
      return
    }
    if (saving || loading || (!creating && !mtime)) return
    setSaving(true)
    setError(null)
    try {
      await writeWorkspaceFile(agentId, filePath, creating ? { content } : { content, ifMatchMtime: mtime! })
      onSaved(filePath)
    } catch (e) {
      setError(
        e instanceof ApiError && e.status === 409
          ? 'The agent is working or the file changed. Retry when it is idle.'
          : msg(e)
      )
      setSaving(false)
    }
  }

  return (
    <div className="scrim">
      <div className="modal desktop:max-w-[760px]" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="modalhead">
          <Icon name={creating ? 'file-plus' : 'pencil'} size={16} />
          <span id={titleId} className="flex-1 font-sans text-[16px] font-semibold leading-normal">
            {creating ? 'New workspace file' : `Edit ${editPath}`}
          </span>
          <button className="iconbtn" aria-label="Close" disabled={saving} onClick={onClose}>
            <Icon name="x" size={16} />
          </button>
        </div>
        <div className="modalbody">
          {loading ? (
            <div className="flex justify-center py-8">
              <Spinner size={28} />
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {creating && (
                <label className="fld">
                  <span className="fldlbl">Workspace-relative path</span>
                  <input
                    className="inp mono"
                    value={path}
                    onChange={(event) => setPath(event.target.value)}
                    placeholder="notes.md"
                    aria-label="New file path"
                    autoFocus
                  />
                </label>
              )}
              <textarea
                className="inp mono min-h-[320px] resize-y px-3 py-[10px] leading-[1.6] focus:border-(--brand) focus:outline-none"
                value={content}
                onChange={(event) => setContent(event.target.value)}
                aria-label={creating ? 'New file content' : `Edit ${editPath}`}
                spellCheck={false}
                disabled={saving || (!creating && !mtime)}
                autoFocus={!creating}
              />
            </div>
          )}
          {error && (
            <div className="mt-3 text-[12.5px] text-(--status-error)" role="alert">
              {error}
            </div>
          )}
        </div>
        <div className="modalfoot">
          <div className="flex-1" />
          <Button variant="ghost" disabled={saving} onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={saving || loading || (!creating && !mtime)} onClick={() => void save()}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>
    </div>
  )
}

// The git-repo header card: remote / branch / working dir on top, the HEAD commit
// + last-pull time below, and Pull-latest / View-on-remote actions in a footer.
function RepoCard({
  git,
  pulling,
  msg,
  onPull
}: {
  git: WorkspaceGitStatusDto
  pulling: boolean
  msg: string | null
  onPull: () => void
}) {
  const remote = parseRemote(git.repo)
  const dirty = !git.clean
  const uncommitted = git.files.length + (git.truncated ? '+' : '')
  const onGitHub = remote ? /github/i.test(remote.host) : false

  return (
    <div className="card">
      <div className="flex items-start gap-3 px-4 py-[14px]">
        <div className="imark h-[38px] w-[38px] text-(--text-secondary)" aria-hidden>
          {onGitHub ? (
            <span className="inline-flex h-[19px] w-[19px]">
              <GithubMark color="var(--text-secondary)" />
            </span>
          ) : (
            <Icon name="git-branch" size={19} />
          )}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-sans text-[14px] font-semibold leading-normal text-(--text-primary)">
              {remote?.label ?? 'workspace'}
            </span>
            {git.branch && (
              <span className="scope inline-flex items-center gap-1">
                <Icon name="git-branch" size={11} />
                {git.branch}
              </span>
            )}
            {git.agentDir && <span className="mono text-[12px] text-(--text-tertiary)">{git.agentDir}</span>}
            <span
              className={`badge ml-auto ${
                dirty ? 'bg-(--status-paused-soft) text-(--amber-500)' : 'bg-(--status-online-soft) text-(--green-500)'
              }`}
              title={dirty ? 'Working tree has uncommitted changes' : 'Working tree clean'}
            >
              <span className="dot h-[6px] w-[6px] bg-current" />
              {dirty ? `${uncommitted} uncommitted` : 'clean'}
            </span>
          </div>

          <div className="mt-1 flex flex-wrap items-center gap-[7px] font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
            {git.lastFetchAt && <span>pulled {fmtMtime(git.lastFetchAt)}</span>}
            {git.lastFetchAt && git.lastCommit && <span aria-hidden>·</span>}
            {git.lastCommit && (
              <span className="inline-flex min-w-0 items-center gap-[7px]">
                <span className="mono font-semibold text-(--brand-soft-text)">{git.lastCommit.shortSha}</span>
                <span className="max-w-[380px] truncate text-(--text-secondary)" title={git.lastCommit.subject}>
                  {git.lastCommit.subject}
                </span>
                <span aria-hidden>·</span>
                <span>{fmtMtime(git.lastCommit.committedAt)}</span>
              </span>
            )}
            {!git.lastFetchAt && !git.lastCommit && <span>No commits yet.</span>}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-[14px] border-t border-(--border-subtle) px-4 py-[10px]">
        <button
          className="iconbtn h-[30px] w-auto gap-[7px] px-3 py-0 text-[13px] font-medium"
          onClick={onPull}
          disabled={pulling}
          title="Fast-forward pull from the remote"
        >
          <Icon name="refresh-cw" size={14} />
          {pulling ? 'Pulling…' : 'Pull latest'}
        </button>
        {remote && (
          <a
            className="lnk text-[13px] text-(--text-secondary)"
            href={remote.url}
            target="_blank"
            rel="noopener noreferrer"
          >
            <Icon name="external-link" size={14} />
            {onGitHub ? 'View on GitHub' : `View on ${remote.host}`}
          </a>
        )}
        {msg && (
          <span className="ml-auto font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">{msg}</span>
        )}
      </div>
    </div>
  )
}

// Non-git ("scratch") live workspace: files exist only on the daemon's disk.
function ScratchCard({ workdir }: { workdir?: string }) {
  return (
    <div className="card">
      <div className="flex items-center gap-[11px] px-4 py-[13px]">
        <span className="imark flex h-[30px] w-[30px] items-center justify-center" aria-hidden>
          <Icon name="folder" size={16} color="var(--text-tertiary)" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="font-sans text-[13.5px] font-semibold leading-normal text-(--text-primary)">
            Scratch workspace
          </div>
          {workdir && <div className="mono mt-[2px] text-[11.5px] text-(--text-tertiary)">{workdir}</div>}
        </div>
      </div>
      <div className="flex items-center gap-[7px] border-t border-(--border-subtle) px-4 py-[11px] font-sans text-[12px] font-normal leading-[1.4] text-(--text-tertiary)">
        <Icon name="info" size={14} />
        Files here are created by the agent and live only on this machine — not version-controlled.
      </div>
    </div>
  )
}
