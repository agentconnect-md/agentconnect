'use client'

// Static workspace browser for demo (mocked-) agents, visually identical to the
// live <WorkspaceFiles> tree: an expandable directory tree on the left (shared
// TreeRow), a preview on the right with a rendered-markdown Preview/Code toggle.
// Purely presentational — rows come straight from the agent's mock nested
// `workspace.files`; live agents stream the real working tree from the daemon.

import { Fragment, useEffect, useMemo, useState } from 'react'
import dynamic from 'next/dynamic'
import { flattenFiles, type WorkspaceFile } from '@/lib/data'
import { indexWorkspaceFileTree, resolveWorkspaceMarkdownLink } from '@/components/console/workspace-links'
import type { MarkdownLinkResolution } from '@/components/console/MarkdownView'
import { StatusBadge } from '@/components/console/workspace-tree'
import { useIsMobile } from '@/lib/use-is-mobile'
import {
  FileBrowserLayout,
  FileBrowserPreviewHeader,
  FileBrowserRow,
  MARKDOWN_FILE_RE
} from '@/components/console/FileBrowser'

const MarkdownView = dynamic(() => import('@/components/console/MarkdownView'), { ssr: false })

// Stable tree path for one mock row (names can repeat across folders).
const keyOf = (prefix: string, f: WorkspaceFile) => (prefix ? `${prefix}/${f.name}` : f.name)

export function WorkspaceFilesMock({ files }: { files: WorkspaceFile[] }) {
  // Default-select the project guide (CLAUDE.md / README.md) so the preview isn't
  // empty on entry; else the first file with content anywhere in the tree.
  const flat = useMemo(() => flattenFiles(files), [files])
  const paths = useMemo(() => indexWorkspaceFileTree(files), [files])
  const initial = useMemo(() => {
    const byName = (n: string) => flat.find((f) => !f.children && f.content && f.name.toLowerCase() === n)
    return byName('claude.md') ?? byName('readme.md') ?? flat.find((f) => !f.children && f.content) ?? null
  }, [flat])
  const isMobile = useIsMobile()
  const [sel, setSel] = useState<WorkspaceFile | null>(initial)
  // Demo trees are small — open every folder so the tree reads at a glance.
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(flattenFiles(files).flatMap((f) => (f.children ? [f.name] : [])))
  )

  const resolveWorkspaceLink = (href: string): MarkdownLinkResolution | undefined => {
    const currentPath = sel && paths.byFile.get(sel)
    if (!currentPath) return undefined
    return resolveWorkspaceMarkdownLink(
      currentPath,
      href,
      (target) => setSel(paths.byPath.get(target.path)!),
      (target) => paths.byPath.has(target.path)
    )
  }

  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  // Mobile preview is a drill-in, so preserve Workspace's list-first entry state.
  useEffect(() => {
    if (isMobile) setSel(null)
  }, [isMobile])

  const renderLevel = (rows: WorkspaceFile[], prefix: string, depth: number, openPreview?: () => void) =>
    rows.map((f) => {
      const key = keyOf(prefix, f)
      if (f.children) {
        const open = expanded.has(f.name)
        return (
          <Fragment key={key}>
            <FileBrowserRow
              depth={depth}
              chevron={open ? 'chevron-down' : 'chevron-right'}
              icon={open ? 'folder-open' : 'folder'}
              name={f.name}
              title={f.meta}
              onClick={() => toggle(f.name)}
            />
            {open && renderLevel(f.children, key, depth + 1, openPreview)}
          </Fragment>
        )
      }
      return (
        <FileBrowserRow
          key={key}
          depth={depth}
          icon={f.icon}
          name={f.name}
          title={f.meta}
          trailing={f.tag ? <StatusBadge ch={f.tag} /> : undefined}
          selected={sel === f}
          onClick={() => {
            setSel(f)
            openPreview?.()
          }}
        />
      )
    })

  return (
    <FileBrowserLayout
      tree={(openPreview) => renderLevel(files, '', 0, openPreview)}
      preview={
        sel
          ? (onBack) => (
              <MockPreview key={paths.byFile.get(sel)} file={sel} resolveLink={resolveWorkspaceLink} onBack={onBack} />
            )
          : null
      }
    />
  )
}

// Right pane for one selected mock file: same minimal header as the live browser
// (icon · name · meta, plus Preview/Code for markdown), then the static content.
function MockPreview({
  file,
  resolveLink,
  onBack
}: {
  file: WorkspaceFile
  resolveLink: (href: string) => MarkdownLinkResolution | undefined
  onBack?: () => void
}) {
  const isMd = MARKDOWN_FILE_RE.test(file.name)
  const [mode, setMode] = useState<'preview' | 'code'>('preview')

  return (
    <>
      <FileBrowserPreviewHeader
        icon={file.icon}
        name={file.name}
        meta={file.meta}
        onBack={onBack}
        actions={
          isMd && file.content ? (
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
      {!file.content ? (
        <div className="flex flex-1 items-center justify-center px-4 py-10 font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
          No preview for this item.
        </div>
      ) : isMd && mode === 'preview' ? (
        <div className="max-h-[420px] overflow-auto px-[18px] py-4">
          <MarkdownView content={file.content} resolveLink={resolveLink} />
        </div>
      ) : (
        <pre className="mono m-0 max-h-[420px] overflow-auto px-4 py-[14px] text-[12px] leading-[1.7] whitespace-pre-wrap text-(--text-secondary)">
          {file.content}
        </pre>
      )}
    </>
  )
}
