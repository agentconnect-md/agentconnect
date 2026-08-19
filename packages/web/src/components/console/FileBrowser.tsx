'use client'

import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react'
import { Spinner } from '@/components/marks'
import { Button, Icon } from '@/components/ui'
import { useIsMobile } from '@/lib/use-is-mobile'

const CODE_EXT = new Set([
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'json',
  'py',
  'go',
  'rs',
  'rb',
  'java',
  'c',
  'h',
  'cpp',
  'cs',
  'sh',
  'bash',
  'zsh',
  'sql',
  'html',
  'css',
  'scss',
  'yaml',
  'yml',
  'toml',
  'xml',
  'proto',
  'tf',
  'dockerfile',
  'prisma'
])

export const MARKDOWN_FILE_RE = /\.(md|markdown|mdx)$/i

export function fileBrowserGlyph(name: string): string {
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : ''
  return CODE_EXT.has(ext) ? 'file-code' : 'file-text'
}

export function formatFileSize(bytes: number | null): string {
  if (bytes == null) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// Relative when recent (matches the fleet's "last seen" feel), short date otherwise.
export function formatFileMtime(iso: string | null): string {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const seconds = Math.round((Date.now() - date.getTime()) / 1000)
  if (!Number.isFinite(seconds) || seconds < 0) {
    return date.toLocaleDateString([], { month: 'short', day: 'numeric' })
  }
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

export type FileBrowserEditorDraft = {
  target: string
  directory: string
  name: string
  content: string
  mtime: string | null
  loading: boolean
  saving: boolean
  error: string | null
}

export function FileBrowserShell({
  title,
  headerEnd,
  children
}: {
  title: ReactNode
  headerEnd?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="card relative max-desktop:rounded-lg">
      <div className="cardhead min-h-[41px] min-w-0 justify-between py-[6px]">
        <div className="cardtitle min-w-0 flex-1 overflow-hidden">{title}</div>
        {headerEnd}
      </div>
      <div className="overflow-hidden rounded-b-[inherit]">{children}</div>
    </div>
  )
}

export function FileBrowserBreadcrumb({
  root,
  path,
  creating,
  draftName,
  onDraftNameChange,
  onBack,
  disabled,
  nested = true,
  rootControl = false,
  ariaLabel = 'File path',
  inputAriaLabel = 'New file path'
}: {
  root: ReactNode
  path: string
  creating: boolean
  draftName: string
  onDraftNameChange: (name: string) => void
  onBack?: () => void
  disabled?: boolean
  nested?: boolean
  /** The root slot holds a CONTROL, not a label: it sizes itself and stays visible inside a path. */
  rootControl?: boolean
  ariaLabel?: string
  inputAriaLabel?: string
}) {
  const baseSegments = path.split('/').filter(Boolean)
  const draftParts = creating ? (nested ? draftName.replace(/^\/+/, '').split('/') : [draftName]) : []
  const draftDirectories = draftParts.slice(0, -1).filter(Boolean)
  const draftLeaf = creating ? (draftParts.at(-1) ?? '') : ''
  const segments = [...baseSegments, ...draftDirectories]
  const updateDraftLeaf = (leaf: string) => onDraftNameChange([...draftDirectories, leaf].join('/'))

  return (
    <nav className="flex min-w-0 items-center gap-[6px] overflow-hidden" aria-label={ariaLabel}>
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
        className={
          rootControl
            ? 'flex min-w-0 flex-none items-center'
            : `mono max-w-[120px] flex-none truncate text-[12px] font-semibold text-(--text-primary) ${
                segments.length > 0 || creating ? 'max-desktop:hidden' : ''
              }`
        }
      >
        {root}
      </span>
      {segments.map((segment, index) => {
        const current = !creating && index === segments.length - 1
        const mobileCurrent = index === segments.length - 1
        return (
          <Fragment key={`${index}:${segment}`}>
            <span className="flex-none text-[12px] font-normal text-(--text-tertiary) max-desktop:hidden" aria-hidden>
              /
            </span>
            <span
              className={`mono min-w-[24px] max-w-[140px] shrink truncate text-[12px] ${
                current ? 'font-semibold text-(--text-primary)' : 'font-medium text-(--text-secondary)'
              } ${mobileCurrent ? '' : 'max-desktop:hidden'}`}
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
          <span className="flex-none text-[12px] font-normal text-(--text-tertiary)" aria-hidden>
            /
          </span>
          <input
            className="inp mono h-7 min-h-7 w-[96px] min-w-16 max-w-full shrink px-2 py-1 text-[12px] desktop:w-[170px] desktop:min-w-[80px] desktop:max-w-[30vw]"
            value={draftLeaf}
            onChange={(event) => updateDraftLeaf(event.target.value)}
            onKeyDown={(event) => {
              if (!nested || event.key !== 'Backspace' || draftLeaf || draftDirectories.length === 0) return
              event.preventDefault()
              onDraftNameChange([...draftDirectories.slice(0, -1), draftDirectories.at(-1)!].join('/'))
            }}
            placeholder="Name your file…"
            aria-label={inputAriaLabel}
            spellCheck={false}
            disabled={disabled}
            autoFocus
          />
        </>
      ) : null}
    </nav>
  )
}

export function FileBrowserEditorActions({
  saving,
  disabled,
  onCancel,
  onSave
}: {
  saving: boolean
  disabled?: boolean
  onCancel: () => void
  onSave: () => void
}) {
  return (
    <div className="flex flex-none items-center gap-2">
      <Button variant="secondary" size="xs" onClick={onCancel} disabled={saving}>
        Cancel
      </Button>
      <Button size="xs" onClick={onSave} disabled={saving || disabled}>
        {saving ? 'Saving…' : 'Save changes'}
      </Button>
    </div>
  )
}

export function FileBrowserEditor({
  draft,
  disabled,
  onContentChange,
  onCancel,
  onSubmit
}: {
  draft: FileBrowserEditorDraft
  disabled?: boolean
  onContentChange: (content: string) => void
  onCancel: () => void
  onSubmit: () => void
}) {
  const creating = draft.target === ''

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !draft.saving) onCancel()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [draft.saving, onCancel])

  return (
    <form
      className="flex min-h-[300px] flex-1 flex-col"
      aria-label={creating ? 'New file' : `Edit ${draft.target}`}
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
            disabled={draft.saving || disabled}
            autoFocus={!creating}
          />
        </div>
      )}
    </form>
  )
}

export function FileBrowserLayout({
  tree,
  preview,
  emptyPreview,
  resetKey,
  openPreviewSignal,
  previewOpen = false
}: {
  tree: (openPreview: () => void) => ReactNode
  preview: ((onBack?: () => void) => ReactNode) | null
  emptyPreview?: ReactNode
  resetKey?: string
  openPreviewSignal?: number
  /** Keep the mobile preview visible while the parent owns an active inline flow. */
  previewOpen?: boolean
}) {
  const isMobile = useIsMobile()
  const [mobilePreviewOpen, setMobilePreviewOpen] = useState(false)
  const previousOpenSignal = useRef(openPreviewSignal)

  useEffect(() => {
    setMobilePreviewOpen(false)
  }, [isMobile, resetKey])

  useEffect(() => {
    if (openPreviewSignal !== undefined && openPreviewSignal !== previousOpenSignal.current) {
      setMobilePreviewOpen(true)
    }
    previousOpenSignal.current = openPreviewSignal
  }, [openPreviewSignal])

  const openPreview = () => {
    if (isMobile) setMobilePreviewOpen(true)
  }

  const showMobilePreview = isMobile && (previewOpen || mobilePreviewOpen) && preview !== null

  return (
    <div className="min-h-[200px] desktop:grid desktop:min-h-[300px] desktop:grid-cols-[260px_1fr] desktop:items-stretch">
      <div
        className={`${
          showMobilePreview ? 'hidden desktop:block' : 'block'
        } min-h-[200px] py-[6px] desktop:max-h-[560px] desktop:min-h-0 desktop:min-w-0 desktop:overflow-y-auto desktop:border-r desktop:border-(--border-subtle)`}
        data-file-browser-pane="tree"
      >
        {tree(openPreview)}
      </div>
      <div
        className={`${showMobilePreview ? 'flex' : 'hidden desktop:flex'} min-w-0 flex-col`}
        data-file-browser-pane="preview"
      >
        {preview
          ? preview(isMobile ? () => setMobilePreviewOpen(false) : undefined)
          : (emptyPreview ?? (
              <div className="flex flex-1 items-center justify-center px-4 py-10 font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
                Select a file to preview.
              </div>
            ))}
      </div>
    </div>
  )
}

export function FileBrowserRow({
  depth = 0,
  icon,
  name,
  chevron,
  title,
  trailing,
  selected,
  onClick
}: {
  depth?: number
  icon: string
  name: string
  chevron?: string
  title?: string
  trailing?: ReactNode
  selected?: boolean
  onClick?: () => void
}) {
  const className = `${
    onClick ? 'file-browser-item cursor-pointer' : 'cursor-default'
  } flex w-full items-center gap-[6px] border-0 border-r-2 py-[6px] pr-[10px] text-left [font:inherit] ${
    selected ? 'border-r-(--brand) bg-(--brand-soft)' : 'border-r-transparent bg-transparent'
  }`
  const contents = (
    <>
      {chevron ? (
        <Icon name={chevron} size={13} color="var(--text-tertiary)" />
      ) : (
        <span className="w-[13px] flex-none" aria-hidden />
      )}
      <Icon name={icon} size={15} color={chevron ? 'var(--text-secondary)' : 'var(--text-tertiary)'} />
      <span
        className={`mono flex-1 truncate text-[12.5px] ${
          selected ? 'text-(--text-primary)' : 'text-(--text-secondary)'
        }`}
      >
        {name}
      </span>
      {trailing}
    </>
  )

  return onClick ? (
    <button
      type="button"
      className={className}
      onClick={onClick}
      title={title || name}
      aria-current={selected ? 'page' : undefined}
      style={{ paddingLeft: 8 + depth * 14 }}
    >
      {contents}
    </button>
  ) : (
    <div className={className} title={title || name} style={{ paddingLeft: 8 + depth * 14 }}>
      {contents}
    </div>
  )
}

export function FileBrowserPreviewHeader({
  icon,
  name,
  meta,
  actions,
  onBack
}: {
  icon: string
  name: string
  meta?: ReactNode
  actions?: ReactNode
  onBack?: () => void
}) {
  return (
    <div className="flex h-[37px] min-w-0 flex-none items-center gap-2 border-b border-(--border-subtle) px-4">
      {onBack && (
        <button
          type="button"
          className="iconbtn h-7 w-7 flex-none"
          onClick={onBack}
          title="Back to files"
          aria-label="Back to files"
        >
          <Icon name="arrow-left" size={15} />
        </button>
      )}
      <Icon name={icon} size={14} color="var(--text-tertiary)" />
      <span className="mono min-w-0 flex-1 truncate text-[12px] font-semibold text-(--text-primary)">{name}</span>
      {meta && (
        <span className="flex-none font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
          {meta}
        </span>
      )}
      {actions}
    </div>
  )
}

export function FileBrowserPreviewSummary({
  meta,
  actions,
  onBack
}: {
  meta?: ReactNode
  actions?: ReactNode
  onBack?: () => void
}) {
  return (
    <div className="flex h-[37px] min-w-0 flex-none items-center gap-2 border-b border-(--border-subtle) px-4">
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
      <span className="min-w-0 flex-1 truncate font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
        {meta}
      </span>
      {actions}
    </div>
  )
}

export function FileBrowserHistoryButton({ active, onClick }: { active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      className={active ? 'dsbtn xs dsbtn-secondary bg-(--surface-active)' : 'dsbtn xs dsbtn-secondary'}
      aria-pressed={active}
      onClick={onClick}
    >
      <Icon name="history" size={14} />
      History
    </button>
  )
}
