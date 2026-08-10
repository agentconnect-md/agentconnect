'use client'

// The session page's viewer mode (§4): ONE workspace file, full height, in place of the transcript and the composer — line-numbered, syntax-coloured, and scrolling inside itself rather than growing the page.
// M1 is File mode only. The Diff / File pill toggle needs a `workspace/gitdiff` frame that does not exist yet (M2), so this header leaves it a slot and stubs nothing.
// Bytes come straight from the owning daemon through the CP (body-locality), so an offline daemon, a path this checkout does not have, a binary file and a file too large for one slice are all expected answers — each is drawn as data.

import { useEffect, useMemo, useRef, useState } from 'react'
import { Spinner } from '@/components/marks'
import { Icon } from '@/components/ui'
import { formatFileSize } from '@/components/console/FileBrowser'
import { escapeHtml, highlight, languageLabel, linkifyHtml, loadHljs } from '@/lib/highlight'
import { ApiError, fetchWorkspaceFile, type WorkspaceFileDto } from '@/lib/api'

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))
const statusOf = (e: unknown) => (e instanceof ApiError ? e.status : null)

// One file read, accumulated slice by slice. `file` is the LATEST slice — it carries the authoritative `nextOffset`/`truncated`/`size`; `content` is every slice so far.
interface Read {
  loading: boolean
  /** Initial-read failure: nothing to show. */
  err: string | null
  /** That failure's HTTP status, when it had one — the CP tells an offline daemon apart from a version that cannot read a worktree. */
  errStatus: number | null
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
  file: null,
  content: '',
  loadingMore: false,
  moreNote: null,
  stale: false
}

// The read failed outright. Only 409 (daemon too old for worktree reads) and 404 (a worktree scope this viewer may not read) are distinguishable; everything else — 503 for an offline daemon and for an unplaced agent, plus a daemon that rejected the path — is the offline story.
function readNoticeText(status: number | null, scoped: boolean): string {
  if (status === 409) {
    return 'This agent runs a daemon version that cannot read a session worktree. Update the agent, or open the file from its workspace page.'
  }
  if (status === 404) {
    return scoped
      ? "This session's worktree is not available to read — it may have been cleaned up, or this session may not have one of its own."
      : 'This workspace is not available to read.'
  }
  return "Couldn't read the file — the owning daemon may be offline. Workspace files live only on that machine and are read live from it, so they are unavailable while it is disconnected."
}

export function SessionViewer({
  agentId,
  sessionId,
  path,
  onClose
}: {
  agentId: string
  /** ACP session id selecting that session's isolated worktree; omit for the agent's primary checkout. Pass it only for a session whose `workspaceIsolation` is `'session'` — the daemon answers a shared-workspace sessionId with BAD_PAYLOAD, which the CP maps to a 503 that reads as "the daemon may be offline". */
  sessionId?: string
  /** Workspace-relative path of the file to read. Changing it starts a fresh read; an older slice can never land in the newer one. */
  path: string
  onClose: () => void
}) {
  const [read, setRead] = useState<Read>(PENDING)
  // Re-reads the same path from byte 0, for a file that changed while it was being read.
  const [reloadTick, setReloadTick] = useState(0)
  // A path check alone cannot tell an A → B → A read apart, so every read is sequenced and an answer that is not the current one is dropped.
  const requestRef = useRef(0)

  useEffect(() => {
    const requestId = ++requestRef.current
    setRead(PENDING)
    fetchWorkspaceFile(agentId, { path, ...(sessionId ? { sessionId } : {}) }).then(
      (f) =>
        setRead((r) =>
          requestId === requestRef.current ? { ...r, loading: false, file: f, content: f.content ?? '' } : r
        ),
      (e) =>
        setRead((r) =>
          requestId === requestRef.current ? { ...r, loading: false, err: msg(e), errStatus: statusOf(e) } : r
        )
    )
    return () => {
      requestRef.current += 1
    }
  }, [agentId, sessionId, path, reloadTick])

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

  const [html, setHtml] = useState<string | null>(null)
  useEffect(() => {
    if (!isText || !text) {
      setHtml(null)
      return
    }
    let active = true
    loadHljs().then(
      (hljs) => {
        if (active) setHtml(highlight(hljs, text, name))
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
  const codeHtml = useMemo(() => (isText && text ? linkifyHtml(html ?? escapeHtml(text)) : null), [isText, text, html])

  // What the file IS, for a reader who arrived on a link: the language only when the mapping is confident, and a line count that says so when it describes a slice rather than the whole file.
  const lineCount = `${lines.length} line${lines.length === 1 ? '' : 's'}`
  const meta = isText
    ? [languageLabel(name), file?.truncated ? `first ${lineCount}` : lineCount, formatFileSize(file?.size ?? null)]
        .filter(Boolean)
        .join(' · ')
    : ''

  return (
    <section className="card flex min-h-0 flex-1 flex-col overflow-hidden max-desktop:m-4">
      <div className="flex flex-none items-center gap-2 border-b border-(--border-subtle) px-4 py-[10px]">
        <Icon name="file" size={15} color="var(--text-tertiary)" className="flex-none" />
        <span className="mono flex min-w-0 flex-1 items-baseline text-[12px] leading-normal" title={path}>
          {dir ? <span className="min-w-0 truncate font-normal text-(--text-tertiary)">{`${dir}/`}</span> : null}
          <span className="flex-none font-medium text-(--text-primary)">{name}</span>
        </span>
        {/* M2's Diff / File pill toggle slots in here, between the path and its meta — nothing else in this header moves for it. */}
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
      {/* Same string, second row: at ≤768px the header has no room for it beside a path, and the path is the half a reader cannot do without. */}
      {meta ? (
        <div className="mono flex-none border-b border-(--border-subtle) px-4 py-[5px] text-[11px] font-normal text-(--text-tertiary) desktop:hidden">
          {meta}
        </div>
      ) : null}

      {read.loading ? (
        <div className="flex flex-1 items-center justify-center py-10">
          <Spinner size={30} />
        </div>
      ) : read.err ? (
        <div className="flex items-start gap-[10px] p-4 font-sans text-[12.5px] font-normal leading-[1.55] text-(--text-secondary)">
          <Icon name="triangle-alert" size={15} color="var(--amber-500)" className="mt-[2px] flex-none" />
          <span>{readNoticeText(read.errStatus, Boolean(sessionId))}</span>
        </div>
      ) : file && !file.exists ? (
        <div className="flex items-start gap-[10px] p-4 font-sans text-[12.5px] font-normal leading-[1.55] text-(--text-secondary)">
          <Icon name="file-question-mark" size={15} color="var(--text-tertiary)" className="mt-[2px] flex-none" />
          <span>
            Not found — this checkout has no file at that path. It may have been removed since the link was made, or the
            link may name another agent&apos;s workspace.
          </span>
        </div>
      ) : file?.encoding === 'none' ? (
        <div className="flex items-center gap-2 p-4 font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
          <Icon name="file-question-mark" size={15} />
          Binary file — not displayed ({formatFileSize(file.size)})
        </div>
      ) : lines.length === 0 ? (
        <div className="p-4 font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
          This file is empty.
        </div>
      ) : (
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
      )}

      {file?.truncated && isText ? (
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
    </section>
  )
}
