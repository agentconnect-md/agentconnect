'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Icon } from '@/components/ui'
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
    <div className="card overflow-hidden max-desktop:rounded-lg">
      <div className="cardhead min-w-0 justify-between">
        <div className="cardtitle min-w-0 flex-1">{title}</div>
        {headerEnd}
      </div>
      {children}
    </div>
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
