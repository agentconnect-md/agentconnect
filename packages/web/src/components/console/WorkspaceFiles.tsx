'use client'

// Live workspace file browser for one agent, GitHub-style: a workspace card up top, an expandable tree on the left, a file preview on the right. Demo agents use <WorkspaceFilesMock>.
// The tree and git-status read model is `workspace-tree.tsx`, shared with the dock's Files panel; this file owns the preview, the editor and the pull, and file bytes are proxied live from the owning daemon (body-locality), so a 503 is an expected state rendered as a notice.
// It projects the git read model into a <WorkspaceHeaderInfo> for `renderHeader` rather than drawing the card, which also carries source and repository-authorization controls needing agent-level data this component has no business fetching.

import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import dynamic from 'next/dynamic'
import {
  ApiError,
  deleteWorkspaceFile,
  fetchWorkspaceFile,
  fetchWorkspaceFileFull,
  writeWorkspaceFile,
  workspaceGitPull,
  type AgentRepoAuthDto,
  type WorkspaceFileDto
} from '@/lib/api'
import { Spinner } from '@/components/marks'
import { Button, Icon } from '@/components/ui'
import { useIsMobile } from '@/lib/use-is-mobile'
import { escapeHtml, highlight, linkifyHtml, loadHljs } from '@/lib/highlight'
import { resolveWorkspaceMarkdownLink } from '@/components/console/workspace-links'
import type { WorkspaceHeaderInfo } from '@/components/console/WorkspaceCard'
import { isGitWorkspace, type Agent } from '@/lib/data'
import type { MarkdownLinkResolution } from '@/components/console/MarkdownView'
import {
  FileBrowserBreadcrumb,
  FileBrowserEditor,
  FileBrowserEditorActions,
  FileBrowserLayout,
  FileBrowserPreviewSummary,
  FileBrowserRow,
  FileBrowserShell,
  MARKDOWN_FILE_RE,
  formatFileMtime,
  formatFileSize,
  type FileBrowserEditorDraft
} from '@/components/console/FileBrowser'
import {
  sessionWorktreeAbsentNotice,
  StatusBadge,
  useWorkspaceGitStatus,
  useWorkspaceTree,
  workspaceDirtyMap,
  workspaceEntryIcon,
  workspaceRootReadState
} from '@/components/console/workspace-tree'
import { WorkspaceRepoPicker } from '@/components/console/WorkspaceRepoPicker'
import { useSandboxWake } from '@/components/console/sandbox-wake'
import {
  SANDBOX_ASLEEP_NOTICE,
  SandboxAsleepNotice,
  SandboxStartingNotice
} from '@/components/console/SandboxWakeNotice'

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
 * and a git → scratch conversion would additionally flip `canEdit` to true
 * over that stale preview. Pass this as the instance's React `key`.
 */
export function workspaceReadModelKey(
  agent: Pick<Agent, 'id' | 'workspace' | 'workdir'>,
  sessionId?: string,
  repo?: string
): string {
  const ws = agent.workspace
  // The repo scope is part of the identity for the same reason the session is: the cached tree,
  // preview and git status belong to ONE root, and switching roots must remount rather than reuse.
  const at = `${agent.id}:${agent.workdir}:${sessionId ?? 'primary'}:${repo ?? 'workspace'}`
  if (!isGitWorkspace(ws)) return `${at}:scratch`
  // Each host names its checkout its own way — GitLab by rename-stable project id, GitHub by owner/repo.
  const source = ws.mode === 'gitlab' ? `gitlab:${ws.projectId ?? ws.repo}` : `github:${ws.repo}`
  return `${at}:${source}@${ws.branch}:${ws.agentDir}`
}

// Parse a full git remote address (https or ssh) into a display label ("org/repo")
// and a browsable https URL. Returns null when it doesn't look like a hosted repo.
function parseRemote(repo: string | null): { label: string; host: string; url: string } | null {
  if (!repo) return null
  const m = repo.match(/^https?:\/\/([^/]+)\/(.+?)(?:\.git)?\/?$/) ?? repo.match(/^git@([^:]+):(.+?)(?:\.git)?\/?$/)
  if (!m) return null
  return { host: m[1]!, label: m[2]!, url: `https://${m[1]}/${m[2]}` }
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

type DeleteDraft = {
  path: string
  mtime: string
  deleting: boolean
  error: string | null
}

export function WorkspaceFiles({
  agentId,
  sessionId,
  repo,
  repoOptions,
  primaryRepoLabel,
  onRepoChange,
  workdir,
  canEdit: workspaceCanEdit,
  sandboxed = false,
  renderWorkspacePicker,
  renderHeader
}: {
  agentId: string
  /** ACP session id selecting that session's isolated worktree. Omit for the
   * agent's primary checkout. */
  sessionId?: string
  /** `owner/repo` of the authorized additional repository being browsed. Omit for the workspace. */
  repo?: string
  /** The agent's authorized additional repositories, offered beside the workspace in the root menu.
   *  Empty ⇒ there is nothing to choose, so the breadcrumb keeps its plain root label. */
  repoOptions?: AgentRepoAuthDto[]
  /** `owner/repo` behind the agent's own workspace; absent ⇒ a scratch workspace, named as one. */
  primaryRepoLabel?: string
  onRepoChange?: (repo: string | null) => void
  workdir?: string
  canEdit: boolean
  /** The agent runs in a cluster sandbox: its files are readable only through a running pod, so opening the tab wakes it rather than waiting for the read to refuse. */
  sandboxed?: boolean
  /** Checkout control rendered opposite the breadcrumb. The branch comes from
   *  the primary checkout's live git status, even while browsing a worktree. */
  renderWorkspacePicker?: (primaryBranch: string | null) => ReactNode
  /** Renders the workspace card above the tree from the live git read model.
   *  Called on every render — including before the status lands (empty info) and
   *  for non-repo workspaces — so the card's own controls are never gated on a
   *  daemon round-trip. */
  renderHeader: (header: WorkspaceHeaderInfo) => ReactNode
}) {
  // The edit frames carry no repo scope, so a write while a secondary root is selected would land in
  // the PRIMARY workspace under the wrong root's name. Editing is the workspace's own, always.
  const canEdit = workspaceCanEdit && !repo
  const isMobile = useIsMobile()
  const [viewer, setViewer] = useState<Viewer | null>(null)
  const [editor, setEditor] = useState<FileBrowserEditorDraft | null>(null)
  const [deleteDraft, setDeleteDraft] = useState<DeleteDraft | null>(null)
  const [mobileListSignal, setMobileListSignal] = useState(0)
  const [gitPulling, setGitPulling] = useState(false)
  const [gitMsg, setGitMsg] = useState<string | null>(null)
  // Bumped after a pull to re-fetch both the git status and the tree.
  const [refreshTick, setRefreshTick] = useState(0)
  // The tree and git halves of the read model, shared with the dock's Files panel.
  const { dirs, expanded, toggleDir, loadMoreDir, openPath } = useWorkspaceTree(agentId, sessionId, refreshTick, repo)
  // `git` is null while loading, for a non-repo workspace, and when the owning daemon is offline — the workspace card falls back to the agent's configured source in all three.
  const { git, primaryBranch } = useWorkspaceGitStatus(agentId, sessionId, refreshTick, repo)
  // The sandbox wake: pressed once when the root read refuses with the asleep code (or on open for a sandboxed agent), then the read is polled through this same refresh until it answers.
  const retryRoot = useCallback(() => setRefreshTick((tick) => tick + 1), [])
  const wake = useSandboxWake(agentId, workspaceRootReadState(dirs['']), retryRoot, { sandboxed })
  // One-shot: on first entry, auto-preview the project guide (CLAUDE.md / README.md).
  const autoOpenedRef = useRef(false)
  // A path check alone cannot distinguish A → B → A requests. Sequence every file
  // read so an older response can never replace or append to a newer selection.
  const viewerRequestRef = useRef(0)

  // Select a file into the right-hand preview pane (fetch its first slice).
  const selectFile = (filePath: string, name: string) => {
    // Any explicit selection supersedes the desktop-only default preview,
    // including a mobile selection carried across a breakpoint change.
    autoOpenedRef.current = true
    setDeleteDraft(null)
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
    fetchWorkspaceFile(agentId, {
      path: filePath,
      ...(sessionId ? { sessionId } : {}),
      ...(repo ? { repo } : {})
    }).then(
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

  // Per-agent view reset (NOT on a refreshTick bump — that would erase the pull
  // message and yank the open file / re-run the one-shot auto-open).
  useEffect(() => {
    viewerRequestRef.current += 1
    setGitMsg(null)
    setViewer(null)
    setEditor(null)
    setDeleteDraft(null)
    setMobileListSignal(0)
    autoOpenedRef.current = false
    return () => {
      viewerRequestRef.current += 1
    }
  }, [agentId, repo, sessionId])

  const editorTarget = editor?.target ?? null

  // Existing files load in full before editing. Creation starts with an empty
  // draft in the directory represented by the breadcrumb.
  useEffect(() => {
    if (!editorTarget) return
    let active = true
    fetchWorkspaceFileFull(agentId, editorTarget, repo ? { repo } : {}).then(
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
  }, [agentId, editorTarget, repo])

  useEffect(() => {
    if (!deleteDraft) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || deleteDraft.deleting) return
      setDeleteDraft(null)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [deleteDraft])

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
    workspaceGitPull(agentId, repo ? { repo } : {}).then(
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
    fetchWorkspaceFile(agentId, {
      path: v.path,
      offset,
      ...(sessionId ? { sessionId } : {}),
      ...(repo ? { repo } : {})
    }).then(
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

  // Browse-relative path → git status letter for the tree badges.
  const dirtyMap = useMemo(() => workspaceDirtyMap(git), [git])

  const root = dirs['']
  const selectedDirectory = viewer ? viewer.path.split('/').slice(0, -1).join('/') : ''
  const workspaceRoot = workdir?.replace(/\/+$/, '').split('/').at(-1) || 'Workspace'
  // The breadcrumb's root has always NAMED the root being browsed; with more than one to browse it
  // becomes the control that chooses it. With nothing to choose it stays the plain label it was.
  const repoChoices = repoOptions ?? []
  const repoPicker =
    repoChoices.length > 0 && onRepoChange ? (
      <WorkspaceRepoPicker
        primaryLabel={primaryRepoLabel || 'Scratch workspace'}
        primaryIsRepo={Boolean(primaryRepoLabel)}
        repos={repoChoices}
        selectedRepo={repo ?? null}
        onChange={onRepoChange}
      />
    ) : null

  const startCreate = () => {
    setDeleteDraft(null)
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
  }

  const startEdit = (path: string) => {
    setDeleteDraft(null)
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
  }

  const startDelete = () => {
    if (!viewer?.file?.exists || !viewer.file.mtime) return
    setDeleteDraft({ path: viewer.path, mtime: viewer.file.mtime, deleting: false, error: null })
  }

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
    const name = editor.name.trim().replace(/^\/+/, '').replace(/\/+/g, '/')
    const filePath = creating ? [editor.directory, name].filter(Boolean).join('/') : editor.target
    if (!filePath || (creating && !name.split('/').at(-1))) {
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

  const confirmDelete = async () => {
    if (!deleteDraft || deleteDraft.deleting) return
    const deleting = deleteDraft
    setDeleteDraft({ ...deleting, deleting: true, error: null })
    try {
      await deleteWorkspaceFile(agentId, deleting.path, deleting.mtime)
      viewerRequestRef.current += 1
      setDeleteDraft(null)
      setViewer(null)
      setRefreshTick((tick) => tick + 1)
    } catch (e) {
      setDeleteDraft((current) =>
        current?.path === deleting.path
          ? {
              ...current,
              deleting: false,
              error:
                e instanceof ApiError && e.status === 409
                  ? 'The agent is working or the file changed. Reload and try again.'
                  : msg(e)
            }
          : current
      )
    }
  }

  const updateCreateName = (name: string) => {
    setEditor((current) => (current?.target === '' ? { ...current, name, error: null } : current))
    if (editor?.target !== '') return
    const typedDirectories = name.replace(/^\/+/, '').split('/').slice(0, -1).filter(Boolean)
    const targetDirectory = [editor.directory, ...typedDirectories].filter(Boolean).join('/')
    if (!targetDirectory) return
    const parts = targetDirectory.split('/').filter(Boolean)
    openPath(parts.map((_, index) => parts.slice(0, index + 1).join('/')))
  }

  const breadcrumbPath = editor ? editor.target || editor.directory : (viewer?.path ?? '')
  const viewerCanEdit =
    canEdit && !!viewer?.file?.exists && viewer.file.encoding === 'utf8' && !!viewer.file.mtime && !viewer.loading
  const viewerCanDelete = canEdit && !!viewer?.file?.exists && !!viewer.file.mtime && !viewer.loading

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
          const meta = [formatFileSize(e.size), formatFileMtime(e.mtime)].filter(Boolean).join(' · ')
          const status = dirtyMap.get(full)
          return (
            <FileBrowserRow
              key={full}
              depth={depth}
              icon={workspaceEntryIcon(e)}
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
  // A secondary root is always a github.com repository (grants exist only for App-covered repos), so
  // its status names `owner/repo` where the primary's names a full clone address.
  const remote = repo
    ? { label: repo, host: 'github.com', url: `https://github.com/${repo}` }
    : git
      ? parseRemote(git.repo)
      : null
  const header: WorkspaceHeaderInfo = {
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
          time: formatFileMtime(git.lastCommit.committedAt),
          title: git.lastCommit.subject
        }
      : null,
    repoUrl: remote?.url ?? null,
    remoteLabel: remote ? (/github/i.test(remote.host) ? 'GitHub' : remote.host) : null,
    ...(git && !sessionId ? { onPull: onGitPull } : {}),
    pulling: gitPulling,
    pullMsg: gitMsg
  }
  const workspacePicker = renderWorkspacePicker?.(primaryBranch)

  return (
    <div className="flex flex-col gap-4">
      {renderHeader(header)}

      <FileBrowserShell
        title={
          <FileBrowserBreadcrumb
            root={repoPicker ?? workspaceRoot}
            rootControl={repoPicker !== null}
            path={breadcrumbPath}
            creating={editor?.target === ''}
            draftName={editor?.name ?? ''}
            onDraftNameChange={updateCreateName}
            onBack={isMobile && editor ? backFromEditor : undefined}
            disabled={editor?.saving}
            ariaLabel="Workspace path"
          />
        }
        headerEnd={
          editor ? (
            <FileBrowserEditorActions
              saving={editor.saving}
              onCancel={closeEditor}
              onSave={() => void saveEditor()}
              disabled={
                editor.loading ||
                (!!editor.target && !editor.mtime) ||
                (!editor.target && !editor.name.trim().split('/').at(-1))
              }
            />
          ) : (
            <div
              className={
                workspacePicker
                  ? 'flex w-1/4 min-w-0 flex-none items-center gap-2 max-desktop:w-[min(210px,56vw)]'
                  : 'flex min-w-0 flex-none items-center gap-2'
              }
            >
              {workspacePicker}
              {deleteDraft ? (
                <>
                  <Button
                    variant="secondary"
                    size="xs"
                    onClick={() => setDeleteDraft(null)}
                    disabled={deleteDraft.deleting}
                  >
                    Cancel
                  </Button>
                  <Button
                    variant="danger"
                    size="xs"
                    onClick={() => void confirmDelete()}
                    disabled={deleteDraft.deleting}
                  >
                    <Icon name="trash-2" size={13} />
                    {deleteDraft.deleting ? 'Deleting…' : 'Delete file'}
                  </Button>
                </>
              ) : canEdit ? (
                <>
                  <Button variant="secondary" size="xs" className="flex-none" onClick={startCreate}>
                    <Icon name="file-plus" size={13} />
                    Add file
                  </Button>
                  {viewerCanEdit ? (
                    <Button variant="secondary" size="xs" className="flex-none" onClick={() => startEdit(viewer!.path)}>
                      <Icon name="pencil" size={13} />
                      Edit
                    </Button>
                  ) : null}
                  {viewerCanDelete ? (
                    <Button variant="secondary" size="xs" className="flex-none" onClick={startDelete}>
                      <Icon name="trash-2" size={13} />
                      Delete
                    </Button>
                  ) : null}
                </>
              ) : null}
            </div>
          )
        }
      >
        {!editor && root?.loading && !root.entries && (
          <div className="flex justify-center py-8">
            <Spinner size={30} />
          </div>
        )}

        {!editor &&
          root?.err &&
          !root.entries &&
          (wake.phase === 'starting' ? (
            <SandboxStartingNotice />
          ) : (
            <SandboxAsleepNotice
              wake={wake}
              startable={sandboxed || workspaceRootReadState(root) === 'asleep'}
              notice={
                <div className="flex items-start gap-[10px] px-[18px] py-4 font-sans text-[12.5px] font-normal leading-[1.55] text-(--text-secondary)">
                  <Icon name="triangle-alert" size={15} color="var(--amber-500)" />
                  <span>
                    {workspaceRootReadState(root) === 'asleep'
                      ? SANDBOX_ASLEEP_NOTICE
                      : 'Couldn’t browse the workspace — the owning daemon may be offline. Files live only on that machine and are read live from it, so they’re unavailable while it is disconnected.'}
                  </span>
                </div>
              }
            />
          ))}

        {!editor && root && !root.loading && !root.err && !root.exists && (
          <EmptyNote
            text={
              // The SESSION scope answers first for every root: the repository sentence below is about the AGENT's checkout, and offering it to a reader looking at one session's worktree promises a materialization that session will never see.
              sessionId
                ? sessionWorktreeAbsentNotice(repo)
                : repo
                  ? 'Not checked out yet — this repository is materialized on the agent’s next session.'
                  : 'The workspace has no files yet — the agent creates them as it works.'
            }
          />
        )}

        {root?.entries && root.exists && root.entries.length === 0 && !editor && (
          <EmptyNote text="This workspace is empty." />
        )}

        {(editor || (root?.entries && root.exists && root.entries.length > 0)) && (
          <FileBrowserLayout
            resetKey={`${agentId}:${sessionId ?? 'primary'}:${repo ?? 'workspace'}:${mobileListSignal}`}
            previewOpen={editor !== null || deleteDraft !== null}
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
                    <FileBrowserEditor
                      draft={editor}
                      disabled={Boolean(editor.target && !editor.mtime)}
                      onContentChange={(content) =>
                        setEditor((current) => (current ? { ...current, content, error: null } : current))
                      }
                      onCancel={closeEditor}
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
                        onBack={
                          onBack
                            ? () => {
                                setDeleteDraft(null)
                                onBack()
                              }
                            : undefined
                        }
                        deletePrompt={deleteDraft?.path === viewer.path ? deleteDraft : null}
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

// The right-hand preview pane: file identity lives in the shell breadcrumb, so
// this toolbar carries only metadata and the Markdown Preview/Code toggle.
// Markdown renders through react-markdown by default (GitHub-style); everything
// else is syntax-highlighted code with bare URLs linkified.
function FilePreview({
  viewer,
  onMore,
  resolveLink,
  onBack,
  deletePrompt
}: {
  viewer: Viewer
  onMore: () => void
  resolveLink: (href: string) => MarkdownLinkResolution | undefined
  onBack?: () => void
  deletePrompt: DeleteDraft | null
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

  const meta = [
    formatFileSize(viewer.file?.size ?? null),
    viewer.file?.mtime ? `edited ${formatFileMtime(viewer.file.mtime)}` : ''
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <>
      <FileBrowserPreviewSummary
        meta={meta}
        onBack={onBack}
        actions={
          isMd && isText ? (
            <span className="pillbar flex-none">
              <button
                className={mode === 'preview' ? 'pill on py-[3px]' : 'pill py-[3px]'}
                onClick={() => setMode('preview')}
              >
                Preview
              </button>
              <button
                className={mode === 'code' ? 'pill on py-[3px]' : 'pill py-[3px]'}
                onClick={() => setMode('code')}
              >
                Code
              </button>
            </span>
          ) : undefined
        }
      />

      {deletePrompt ? (
        <div
          className="flex items-start gap-[10px] border-b border-(--border-subtle) bg-(--status-error-soft) px-4 py-3 font-sans text-[12.5px] font-normal leading-[1.5] text-(--text-secondary)"
          role="alert"
        >
          <Icon name="triangle-alert" size={15} color="var(--status-error)" className="mt-[2px] flex-none" />
          <div>
            <span className="font-semibold text-(--text-primary)">Delete this file?</span> This cannot be undone.
            {deletePrompt.error ? <div className="mt-1 text-(--status-error)">{deletePrompt.error}</div> : null}
          </div>
        </div>
      ) : null}

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
          Binary file — not displayed ({formatFileSize(viewer.file.size)})
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
                Showing first {formatFileSize(viewer.file.nextOffset)} of {formatFileSize(viewer.file.size)}
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
