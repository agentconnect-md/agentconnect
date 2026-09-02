'use client'

// The session page's viewer mode (§4): ONE workspace path, full height, in place of the transcript and the composer — as line-numbered syntax-coloured source (File mode), or as the unified diff of what the agent changed (Diff mode).
// Both halves are read live from the owning daemon through the CP (body-locality), so an offline daemon, a path this checkout does not have, a binary file, a file too large for one slice, a workspace that is not a git checkout and a path with no changes in the scope asked for are all expected answers — each is drawn as data, never as a failure of the pane.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Spinner } from '@/components/marks'
import { Icon } from '@/components/ui'
import { formatFileSize } from '@/components/console/FileBrowser'
import { LineDiffTable } from '@/components/console/LineDiff'
import { parseUnifiedDiff } from '@/components/console/viewer/unified-diff'
import { gitWriteRequestFailureText } from '@/components/console/dock/git-write'
import { escapeHtml, highlight, languageLabel, linkifyHtml, loadHljs } from '@/lib/highlight'
import {
  ApiError,
  fetchWorkspaceFile,
  fetchWorkspaceGitDiff,
  stageWorkspacePaths,
  unstageWorkspacePaths,
  type WorkspaceDiffScope,
  type WorkspaceFileDto,
  type WorkspaceGitDiffDto
} from '@/lib/api'

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))
const statusOf = (e: unknown) => (e instanceof ApiError ? e.status : null)
const codeOf = (e: unknown) => (e instanceof ApiError && e.code ? e.code : null)

/** What the pane is showing. `staged` is the diff of the index against HEAD, `diff` the worktree against the index — two different reads of one path, so the mode names the scope rather than carrying a second parameter. */
export type ViewerMode = 'file' | 'diff' | 'staged'

/** The `?mode=` param as a mode. Anything else — a stale link, a hand-typed value — reads as File mode: it is the one read that works on every workspace, so an unreadable mode degrades to the path itself rather than to an error. */
export function viewerModeFromParam(value: string | null): ViewerMode {
  return value === 'diff' || value === 'staged' ? value : 'file'
}

const SCOPE_OF: Record<ViewerMode, WorkspaceDiffScope> = { file: 'unstaged', diff: 'unstaged', staged: 'staged' }

// One file read, accumulated slice by slice. `file` is the LATEST slice — it carries the authoritative `nextOffset`/`truncated`/`size`; `content` is every slice so far.
interface Read {
  loading: boolean
  /** Initial-read failure: nothing to show. */
  err: string | null
  /** That failure's HTTP status, when it had one — the CP tells an offline daemon apart from a version that cannot read a worktree. */
  errStatus: number | null
  /** The CP's machine-readable reason, so a path that escapes the workspace or names git internals reads as itself rather than as the generic failure. */
  errCode: string | null
  file: WorkspaceFileDto | null
  content: string
  loadingMore: boolean
  /** Append failure or a mid-read revision change — keeps the slices already read. */
  moreNote: string | null
  /** The file changed under the read, so appending would splice two revisions. */
  stale: boolean
}

const PENDING: Read = {
  loading: true,
  err: null,
  errStatus: null,
  errCode: null,
  file: null,
  content: '',
  loadingMore: false,
  moreNote: null,
  stale: false
}

/** One diff read, per scope. Kept even while the reader is in File mode, so the pill is a toggle and not a refetch. */
interface DiffRead {
  loading: boolean
  err: string | null
  errStatus: number | null
  /** The CP's machine-readable reason, which is what tells a path the daemon refused from a daemon that is simply gone. */
  errCode: string | null
  diff: WorkspaceGitDiffDto | null
}

const DIFF_PENDING: DiffRead = { loading: true, err: null, errStatus: null, errCode: null, diff: null }

// A workspace read failed outright. The CP's status and `code` are what make the distinguishable cases distinguishable; everything else — 503 for an offline daemon and for an unplaced agent alike, plus network failures — is the offline story.
function readNoticeText(status: number | null, code: string | null, scoped: boolean): string {
  if (status === 409) {
    return code === 'DAEMON_FEATURE_MISSING'
      ? 'This agent runs a daemon version that cannot read diffs. Update the agent to review its changes here; the file itself still opens.'
      : 'This agent runs a daemon version that cannot read a session checkout. Update the agent, or open the file from its workspace page.'
  }
  if (status === 404) {
    return scoped
      ? "This session's checkout is not available to read — it may have been cleaned up, or this session may not have one of its own."
      : 'This workspace is not available to read.'
  }
  if (status === 400 && code === 'WORKSPACE_GIT_INTERNALS') {
    return 'That path reaches inside .git, which the console does not read.'
  }
  if (status === 400 && code === 'WORKSPACE_PATH_ESCAPE') {
    return 'That path is not inside this workspace, so it was not read.'
  }
  if (status === 400) return 'The daemon could not read that path.'
  return "Couldn't read the file — the owning daemon may be offline. Workspace files live only on that machine and are read live from it, so they are unavailable while it is disconnected."
}

const PILL_BASE =
  'flex-none rounded-xs border-0 px-[7px] py-px font-sans text-[11px] font-medium leading-normal transition-colors'
const PILL_ON = `${PILL_BASE} bg-(--surface-card) text-(--text-primary) shadow-(--shadow-xs)`
const PILL_OFF = `${PILL_BASE} bg-transparent text-(--text-secondary) hover:text-(--text-primary)`

export function SessionViewer({
  agentId,
  sessionId,
  path,
  mode = 'file',
  diffRefreshTick = 0,
  onModeChange,
  onIndexChanged,
  onClose
}: {
  agentId: string
  /** ACP session id selecting that session's isolated worktree; omit for the agent's primary checkout. Pass it only for a session whose `workspaceIsolation` is `'session'` — the daemon answers a shared-workspace sessionId with BAD_PAYLOAD, which the CP maps to a 503 that reads as "the daemon may be offline". */
  sessionId?: string
  /** Workspace-relative path of the file to read. Changing it starts a fresh read; an older slice can never land in the newer one. */
  path: string
  /** Which read is on screen. It lives in the URL beside `file` (§4), so the caller owns it and this pane reports the pill instead of holding a second copy. */
  mode?: ViewerMode
  /** Bumped by the caller when something ELSE moved the index — the Git panel's own toggles — so the diff on screen is re-read instead of describing a tree that has moved. The file bytes are untouched by an index write, so it does not invalidate the File read. */
  diffRefreshTick?: number
  /** The pill was pressed. Omitted ⇒ no pill: a host with nowhere to keep the mode must not offer to change it. */
  onModeChange?: (mode: ViewerMode) => void
  /** This pane staged or unstaged the open path. Omitted ⇒ no Stage/Unstage action at all, which is how a reader whose role cannot write, and a host with nothing to re-read, both get a pane that does not offer one. */
  onIndexChanged?: () => void
  onClose: () => void
}) {
  const [read, setRead] = useState<Read>(PENDING)
  // Re-reads the same path from byte 0, for a file that changed while it was being read.
  const [reloadTick, setReloadTick] = useState(0)
  // A path check alone cannot tell an A → B → A read apart, so every read is sequenced and an answer that is not the current one is dropped.
  const requestRef = useRef(0)
  // Whether the bytes have ever been asked for. A link straight into Diff mode must not spend a `workspace/read` on a pane that is not going to draw it — but once File mode has been visited the read stays, so the pill is a toggle rather than a round trip.
  const [fileSeen, setFileSeen] = useState(mode === 'file')
  useEffect(() => {
    if (mode === 'file') setFileSeen(true)
  }, [mode])
  const fileWanted = fileSeen || mode === 'file'
  // Which diff scope the pill goes back to: a reader who arrived from the Git panel's Staged section and looked at the file gets the STAGED diff back, not the other side of the index.
  const [lastDiffMode, setLastDiffMode] = useState<ViewerMode>(mode === 'file' ? 'diff' : mode)
  useEffect(() => {
    if (mode !== 'file') setLastDiffMode(mode)
  }, [mode])

  useEffect(() => {
    if (!fileWanted) return
    const requestId = ++requestRef.current
    setRead(PENDING)
    fetchWorkspaceFile(agentId, { path, ...(sessionId ? { sessionId } : {}) }).then(
      (f) =>
        setRead((r) =>
          requestId === requestRef.current ? { ...r, loading: false, file: f, content: f.content ?? '' } : r
        ),
      (e) =>
        setRead((r) =>
          requestId === requestRef.current
            ? { ...r, loading: false, err: msg(e), errStatus: statusOf(e), errCode: codeOf(e) }
            : r
        )
    )
    return () => {
      requestRef.current += 1
    }
  }, [agentId, sessionId, path, reloadTick, fileWanted])

  // One entry per read, so switching Diff → File → Diff redraws instead of re-reading. Keyed by the WHOLE read — checkout, worktree, path, scope, retry — not by the scope alone: the caller remounts this pane on a path change today, and a cache that relied on that would paint one path's diff under another's heading the day it stops.
  const [diffs, setDiffs] = useState<Record<string, DiffRead>>({})
  const [diffTick, setDiffTick] = useState(0)
  const diffScope = SCOPE_OF[mode]
  const wantDiff = mode !== 'file'
  // A newline joins the parts because a POSIX path may contain a space: two different reads must not collide on one key. Both ticks ride the key — the pane's own Retry and its own writes, and the caller's "the index moved under you" — so an invalidated diff is a NEW read rather than a mutated entry.
  const diffKey = [agentId, sessionId ?? '', path, diffScope, diffTick, diffRefreshTick].join('\n')
  // Which reads this mount has already issued, so an effect firing again for an unrelated reason does not re-issue one that is already in flight.
  const askedRef = useRef(new Set<string>())
  useEffect(() => {
    if (!wantDiff) return
    if (askedRef.current.has(diffKey)) return
    askedRef.current.add(diffKey)
    setDiffs((current) => ({ ...current, [diffKey]: DIFF_PENDING }))
    // Deliberately NOT cancelled on cleanup. `diffKey` already names the read, so a late answer can only land on its own entry — while cancelling stranded it: leaving diff mode tore the read down, and coming back short-circuited on `askedRef`, so the pane span on a spinner with no Retry until the scope or the path changed.
    fetchWorkspaceGitDiff(agentId, { path, scope: diffScope, ...(sessionId ? { sessionId } : {}) }).then(
      (d) => setDiffs((current) => ({ ...current, [diffKey]: { ...DIFF_PENDING, loading: false, diff: d } })),
      (e) =>
        setDiffs((current) => ({
          ...current,
          [diffKey]: { ...DIFF_PENDING, loading: false, err: msg(e), errStatus: statusOf(e), errCode: codeOf(e) }
        }))
    )
  }, [agentId, sessionId, path, diffScope, diffKey, wantDiff])
  const retryDiff = () => setDiffTick((tick) => tick + 1)
  // The header's Stage file / Unstage file (§4). One in flight at a time, and its failure is a footer line rather than a lost press.
  const [moving, setMoving] = useState(false)
  const [moveErr, setMoveErr] = useState<string | null>(null)
  const diffRead = diffs[diffKey]
  const diff = diffRead?.diff ?? null
  // Parsed from the diff TEXT, not recomputed from two blobs: git already did the matching, and its rename and whitespace handling is what a reviewer is reading.
  const parsed = useMemo(() => (diff?.diff ? parseUnifiedDiff(diff.diff) : null), [diff?.diff])

  // Whether this path has something to move in the scope on screen. The pane never learns the file's XY status letters, so the SCOPE is what names the direction: the staged diff's content is what unstaging takes out, the unstaged diff's is what staging puts in. A binary change counts — git reports it with no text, and it is still stageable.
  const movable = mode !== 'file' && diff !== null && diff.isRepo && diff.exists && (diff.diff !== null || diff.binary)
  const moveIndex = async () => {
    if (moving || !movable) return
    setMoving(true)
    setMoveErr(null)
    try {
      const write = mode === 'staged' ? unstageWorkspacePaths : stageWorkspacePaths
      await write(agentId, { paths: [path], ...(sessionId ? { sessionId } : {}) })
      // The reply's fresh status has no home in this pane, so the panel that owns the lists is told instead; the diff under the reader is re-read because it just changed by definition.
      setDiffTick((tick) => tick + 1)
      onIndexChanged?.()
    } catch (e) {
      setMoveErr(gitWriteRequestFailureText(statusOf(e), codeOf(e)))
    } finally {
      setMoving(false)
    }
  }

  const file = read.file
  // The daemon's own byte offset, never recomputed from the decoded text: a slice can end mid-character, so the decoded length drifts from the byte count.
  const nextOffset =
    file?.truncated && file.nextOffset != null && file.nextOffset > (file.offset ?? 0) ? file.nextOffset : null

  const loadMore = () => {
    if (nextOffset === null || read.loadingMore || read.stale) return
    const requestId = requestRef.current
    const at = nextOffset
    const readMtime = file?.mtime ?? null
    setRead((r) => ({ ...r, loadingMore: true, moreNote: null }))
    fetchWorkspaceFile(agentId, { path, offset: at, ...(sessionId ? { sessionId } : {}) }).then(
      (f) =>
        setRead((r) => {
          if (requestId !== requestRef.current) return r
          // Fenced on mtime like the editor's whole-file read: appending across a revision change would assemble one document out of two.
          if (readMtime && f.mtime && f.mtime !== readMtime) {
            return {
              ...r,
              loadingMore: false,
              stale: true,
              moreNote: 'The agent changed this file while it was loading — reload it to read the current version.'
            }
          }
          return { ...r, loadingMore: false, file: f, content: r.content + (f.content ?? '') }
        }),
      () =>
        setRead((r) =>
          requestId === requestRef.current
            ? { ...r, loadingMore: false, moreNote: "Couldn't load more — the daemon may be offline." }
            : r
        )
    )
  }

  const name = path.split('/').at(-1) ?? path
  const dir = path.slice(0, Math.max(0, path.length - name.length - 1))
  const isText = file?.exists === true && file.encoding === 'utf8'

  // Lines as an editor counts them: a trailing newline ENDS the last line rather than beginning an empty one, so the gutter and the header's count describe the same rows.
  const lines = useMemo(() => {
    if (!read.content) return []
    const parts = read.content.split('\n')
    if (parts.length > 1 && parts[parts.length - 1] === '') parts.pop()
    return parts
  }, [read.content])
  // Rendered and highlighted from the SAME string as the gutter is numbered from.
  const text = useMemo(() => lines.join('\n'), [lines])
  const gutter = useMemo(() => lines.map((_, index) => index + 1).join('\n'), [lines])

  // Highlighted HTML is stored WITH the source it was produced from. The highlighter is async, so a paginated or reloaded slice would otherwise render the previous revision's colouring — and its gutter — beside the new source for as many paints as the pass takes; escaped plain text is the correct thing to show in that window.
  const [html, setHtml] = useState<{ text: string; name: string; html: string } | null>(null)
  useEffect(() => {
    if (!isText || !text) {
      setHtml(null)
      return
    }
    let active = true
    loadHljs().then(
      (hljs) => {
        if (!active) return
        // `highlight` declines an unknown language by returning null — the same "use escaped text" answer as a failed load.
        const marked = highlight(hljs, text, name)
        setHtml(marked === null ? null : { text, name, html: marked })
      },
      () => {
        // Highlighter unavailable: escaped plain text through the same pipeline.
        if (active) setHtml(null)
      }
    )
    return () => {
      active = false
    }
  }, [isText, text, name])
  const fresh = html && html.text === text && html.name === name ? html.html : null
  const codeHtml = useMemo(
    () => (isText && text ? linkifyHtml(fresh ?? escapeHtml(text)) : null),
    [isText, text, fresh]
  )

  // What the file IS, for a reader who arrived on a link: the language only when the mapping is confident, and a line count that says so when it describes a slice rather than the whole file.
  const lineCount = `${lines.length} line${lines.length === 1 ? '' : 's'}`
  const fileMeta = isText
    ? [languageLabel(name), file?.truncated ? `first ${lineCount}` : lineCount, formatFileSize(file?.size ?? null)]
        .filter(Boolean)
        .join(' · ')
    : ''
  // In Diff mode the same slot carries what CHANGED, counted from the rows on screen rather than from the git-status row: that row counts both sides of the index against HEAD, while this pane shows one scope of one path, so its numbers would disagree with the diff under them.
  const diffMeta =
    parsed && (parsed.additions > 0 || parsed.deletions > 0) ? (
      <>
        <span className="text-(--status-online)">{`+${parsed.additions}`}</span>{' '}
        <span className="text-(--status-error)">{`−${parsed.deletions}`}</span>
        {diff?.truncated || parsed.rowsTruncated ? <span>{' · partial'}</span> : null}
      </>
    ) : null
  const meta: ReactNode = mode === 'file' ? fileMeta || null : diffMeta

  // Why a diff has nothing to draw. Each of these is an ANSWER — the read succeeded and this is what it said.
  const diffNotice = (): { text: string; warn: boolean } | null => {
    if (!diff) return null
    if (!diff.isRepo) {
      return {
        text: 'This workspace is not a git checkout, so there is nothing to diff. Read the file instead.',
        warn: false
      }
    }
    if (!diff.exists) {
      return {
        text: 'This checkout has neither changes nor a file at that path. It may have been removed since the link was made, or the link may name another agent’s workspace.',
        warn: false
      }
    }
    if (diff.binary) {
      return {
        text: 'Binary file — git reports a change it has no text for, so there is nothing to show line by line.',
        warn: false
      }
    }
    if (!diff.diff) {
      return {
        text:
          mode === 'staged'
            ? 'Nothing staged for this file. Its unstaged edits, if any, are under Diff.'
            : 'No unstaged changes to this file. Anything already staged is shown from the Git panel’s Staged section.',
        warn: false
      }
    }
    if (parsed && parsed.rows.length === 0) {
      return {
        text: 'git reported a change with no line content — a mode change, or a rename with no edits.',
        warn: false
      }
    }
    return null
  }

  const diffBody = (): ReactNode => {
    if (!diffRead || diffRead.loading) {
      return (
        <div className="flex flex-1 items-center justify-center py-10">
          <Spinner size={30} />
        </div>
      )
    }
    if (diffRead.err) {
      return (
        <div className="flex items-start gap-[10px] p-4 font-sans text-[12.5px] font-normal leading-[1.55] text-(--text-secondary)">
          <Icon name="triangle-alert" size={15} color="var(--amber-500)" className="mt-[2px] flex-none" />
          <span>
            {readNoticeText(diffRead.errStatus, diffRead.errCode, Boolean(sessionId))}{' '}
            <button className="lnk text-[12.5px]" onClick={retryDiff}>
              Retry
            </button>
          </span>
        </div>
      )
    }
    const notice = diffNotice()
    if (notice) {
      return (
        <div className="flex items-start gap-[10px] p-4 font-sans text-[12.5px] font-normal leading-[1.55] text-(--text-secondary)">
          <Icon
            name={notice.warn ? 'triangle-alert' : 'file-diff'}
            size={15}
            color={notice.warn ? 'var(--amber-500)' : 'var(--text-tertiary)'}
            className="mt-[2px] flex-none"
          />
          <span>{notice.text}</span>
        </div>
      )
    }
    return (
      // The same scroller File mode uses, for the same reason: a long diff must scroll here rather than grow `.content` and move the transcript's anchor.
      <div className="min-h-0 flex-1 overflow-auto" data-viewer-diff="">
        <LineDiffTable rows={parsed?.rows ?? []} label={`Diff of ${path}`} />
      </div>
    )
  }

  const fileBody = (): ReactNode => {
    if (read.loading) {
      return (
        <div className="flex flex-1 items-center justify-center py-10">
          <Spinner size={30} />
        </div>
      )
    }
    if (read.err) {
      return (
        <div className="flex items-start gap-[10px] p-4 font-sans text-[12.5px] font-normal leading-[1.55] text-(--text-secondary)">
          <Icon name="triangle-alert" size={15} color="var(--amber-500)" className="mt-[2px] flex-none" />
          <span>{readNoticeText(read.errStatus, read.errCode, Boolean(sessionId))}</span>
        </div>
      )
    }
    if (file && !file.exists) {
      return (
        <div className="flex items-start gap-[10px] p-4 font-sans text-[12.5px] font-normal leading-[1.55] text-(--text-secondary)">
          <Icon name="file-question-mark" size={15} color="var(--text-tertiary)" className="mt-[2px] flex-none" />
          <span>
            Not found — this checkout has no file at that path. It may have been removed since the link was made, or the
            link may name another agent&apos;s workspace.
          </span>
        </div>
      )
    }
    // A directory is DATA, not the empty file it used to read as: the daemon answers `type:'dir'` with no bytes at all.
    if (file?.type === 'dir') {
      return (
        <div className="flex items-start gap-[10px] p-4 font-sans text-[12.5px] font-normal leading-[1.55] text-(--text-secondary)">
          <Icon name="folder-open" size={15} color="var(--text-tertiary)" className="mt-[2px] flex-none" />
          <span>That path is a folder, not a file. Open it in the Files tab to see what is inside it.</span>
        </div>
      )
    }
    if (file?.encoding === 'none') {
      return (
        <div className="flex items-center gap-2 p-4 font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
          <Icon name="file-question-mark" size={15} />
          Binary file — not displayed ({formatFileSize(file.size)})
        </div>
      )
    }
    if (lines.length === 0) {
      return (
        <div className="p-4 font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
          This file is empty.
        </div>
      )
    }
    return (
      // The viewer's OWN scroller: the page's `.content` is what the transcript's stick-to-bottom pins, so a file that grew the page would move the transcript's anchor instead of scrolling here.
      <div className="min-h-0 flex-1 overflow-auto" data-viewer-code="">
        <div className="flex min-w-max">
          {/* One text node, not a row per line: the numbers then share the code's line boxes by construction, and `sticky` keeps them in place while a long line scrolls sideways. */}
          <pre
            aria-hidden="true"
            data-viewer-gutter=""
            className="mono sticky left-0 z-[1] m-0 flex-none select-none border-r border-(--border-subtle) bg-(--surface-card) px-3 py-[14px] text-right text-[12px] leading-[1.7] whitespace-pre text-(--text-disabled)"
          >
            {gutter}
          </pre>
          <pre className="hljs mono m-0 flex-none bg-transparent px-4 py-[14px] text-[12px] leading-[1.7] whitespace-pre text-(--text-primary)">
            {codeHtml != null ? <code dangerouslySetInnerHTML={{ __html: codeHtml }} /> : <code>{text}</code>}
          </pre>
        </div>
      </div>
    )
  }

  return (
    <section className="card flex min-h-0 flex-1 flex-col overflow-hidden max-desktop:m-4">
      <div className="flex flex-none items-center gap-2 border-b border-(--border-subtle) px-4 py-[10px]">
        <Icon
          name={mode === 'file' ? 'file' : 'file-diff'}
          size={15}
          color="var(--text-tertiary)"
          className="flex-none"
        />
        <span className="mono flex min-w-0 flex-1 items-baseline text-[12px] leading-normal" title={path}>
          {dir ? <span className="min-w-0 truncate font-normal text-(--text-tertiary)">{`${dir}/`}</span> : null}
          <span className="flex-none font-medium text-(--text-primary)">{name}</span>
        </span>
        {/* The Diff / File pill (§4). Diff returns to the scope this mount last showed, so a reader who came in from the Staged section does not silently land on the unstaged diff. */}
        {onModeChange ? (
          <div
            data-viewer-modes=""
            className="flex flex-none items-center gap-px rounded-sm bg-(--surface-sunken) p-px"
            role="group"
            aria-label="Viewer mode"
          >
            <button
              type="button"
              className={mode === 'file' ? PILL_OFF : PILL_ON}
              data-viewer-mode="diff"
              aria-pressed={mode !== 'file'}
              title={lastDiffMode === 'staged' ? 'Staged changes to this file' : 'Unstaged changes to this file'}
              onClick={() => onModeChange(lastDiffMode)}
            >
              Diff
            </button>
            <button
              type="button"
              className={mode === 'file' ? PILL_ON : PILL_OFF}
              data-viewer-mode="file"
              aria-pressed={mode === 'file'}
              title="The file as it is on disk"
              onClick={() => onModeChange('file')}
            >
              File
            </button>
          </div>
        ) : null}
        {/* Stage file / Unstage file (§4). Withheld until the diff has answered with something to move: an action over a path with no changes in this scope would be a no-op dressed as a control. */}
        {onIndexChanged && movable ? (
          <button
            type="button"
            data-viewer-stage={mode === 'staged' ? 'unstage' : 'stage'}
            className="dsbtn dsbtn-secondary xs flex-none disabled:pointer-events-none disabled:opacity-50"
            disabled={moving}
            title={
              mode === 'staged'
                ? 'Take this file out of the index; the working tree is untouched'
                : 'Add this file’s changes to the index'
            }
            onClick={() => void moveIndex()}
          >
            {moving ? <Spinner size={12} /> : <Icon name={mode === 'staged' ? 'minus' : 'plus'} size={13} />}
            <span className="max-desktop:hidden">{mode === 'staged' ? 'Unstage file' : 'Stage file'}</span>
          </button>
        ) : null}
        {meta ? (
          <span className="mono flex-none text-[11px] font-normal text-(--text-tertiary) max-desktop:hidden">
            {meta}
          </span>
        ) : null}
        <button
          type="button"
          className="iconbtn flex-none"
          data-viewer-close=""
          aria-label="Back to the conversation"
          title="Back to the conversation"
          onClick={onClose}
        >
          <Icon name="x" size={15} />
        </button>
      </div>
      {/* Same content, second row: at ≤768px the header has no room for it beside a path, and the path is the half a reader cannot do without. */}
      {meta ? (
        <div className="mono flex-none border-b border-(--border-subtle) px-4 py-[5px] text-[11px] font-normal text-(--text-tertiary) desktop:hidden">
          {meta}
        </div>
      ) : null}

      {mode === 'file' ? fileBody() : diffBody()}

      {/* A stage that never reached an answer. Below the header rather than inside it, because the header has one line's worth of room and this is a sentence. */}
      {moveErr ? (
        <div
          data-viewer-stage-error=""
          className="flex flex-none items-start gap-[6px] border-t border-(--border-subtle) px-4 py-[9px] font-sans text-[12px] font-normal leading-[1.5] text-(--red-600)"
        >
          <Icon name="triangle-alert" size={14} color="var(--red-600)" className="mt-[2px] flex-none" />
          <span>{moveErr}</span>
        </div>
      ) : null}

      {mode === 'file' && file?.truncated && isText ? (
        <div className="flex flex-none flex-wrap items-center gap-x-[10px] gap-y-1 border-t border-(--border-subtle) px-4 py-[9px] font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
          {/* The slice's own end offset names how much is on screen; a truncated slice that named no offset it could continue from can still say the whole file is bigger. */}
          <span>
            {nextOffset !== null
              ? `Showing first ${formatFileSize(nextOffset)} of ${formatFileSize(file.size)}`
              : `Showing part of ${formatFileSize(file.size)}`}
          </span>
          {read.stale ? (
            <button className="lnk text-[12px]" onClick={() => setReloadTick((tick) => tick + 1)}>
              Reload
            </button>
          ) : nextOffset !== null ? (
            <button className="lnk text-[12px]" onClick={loadMore} disabled={read.loadingMore}>
              {read.loadingMore ? 'Loading…' : read.moreNote ? 'Retry' : 'Load more'}
            </button>
          ) : null}
          {read.moreNote ? <span>{read.moreNote}</span> : null}
        </div>
      ) : null}

      {/* Some hunk header in this diff could not be read, so its body is passed through verbatim rather than split into added and removed sides. A conflicted file is the common cause: git writes a COMBINED diff whose sign column has one slot per parent, and reading it as a single column would draw a real addition as an unchanged line. Say so rather than let the reader trust the gutter. */}
      {mode !== 'file' && parsed && parsed.malformedHunks > 0 ? (
        <div
          data-viewer-diff-unsided=""
          className="flex-none border-t border-(--border-subtle) bg-(--status-paused-soft) px-4 py-[9px] font-sans text-[12px] font-normal leading-normal text-(--text-secondary)"
        >
          Part of this diff is shown exactly as git wrote it, without added/removed sides — its hunk header is not a
          plain two-way one, which is what a file with merge conflicts produces. The counts above cover only the parts
          that could be read.
        </div>
      ) : null}

      {/* A cut diff says so where the file's own truncation footer says it: the wire stopped at the frame cap, the parser stopped at its row cap, or both. */}
      {mode !== 'file' && parsed && (diff?.truncated || parsed.rowsTruncated) ? (
        <div
          data-viewer-diff-truncated=""
          className="flex-none border-t border-(--border-subtle) px-4 py-[9px] font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)"
        >
          {diff?.truncated
            ? 'This diff is too large to send whole — only its first part is shown. Open the file to read the rest.'
            : 'This diff has more lines than the viewer draws — only its first part is shown.'}
        </div>
      ) : null}
    </section>
  )
}
