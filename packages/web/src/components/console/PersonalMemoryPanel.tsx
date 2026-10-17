'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import dynamic from 'next/dynamic'
import { fetchMyAgentMemoryFull, listMyAgentMemory, type MemoryFileEntry } from '@/lib/api'
import { Spinner } from '@/components/marks'
import {
  FileBrowserLayout,
  FileBrowserPreviewHeader,
  FileBrowserRow,
  FileBrowserShell,
  formatFileMtime,
  formatFileSize
} from '@/components/console/FileBrowser'

// Loaded lazily like the other memory views so react-markdown never ships in the main console bundle.
const MarkdownView = dynamic(() => import('@/components/console/MarkdownView'), {
  ssr: false,
  loading: () => <p className="text-(--text-tertiary)">{'Loading…'}</p>
})

type Listing = { state: 'loading' } | { state: 'ready'; files: MemoryFileEntry[] } | { state: 'unavailable' }
type Opened = { name: string; content: string | null; mtime: string | null; failed?: true }

// The signed-in user's own memory layer for this agent, read-only: nobody else can open it, editors included.
export function PersonalMemoryPanel({ agentId }: { agentId: string }) {
  const t = useTranslations('Agents.detail.memory')
  const [listing, setListing] = useState<Listing>({ state: 'loading' })
  const [opened, setOpened] = useState<Opened | null>(null)

  useEffect(() => {
    let live = true
    setListing({ state: 'loading' })
    setOpened(null)
    void listMyAgentMemory(agentId)
      .then((page) => {
        if (live) setListing({ state: 'ready', files: page.files })
      })
      .catch(() => {
        if (live) setListing({ state: 'unavailable' })
      })
    return () => {
      live = false
    }
  }, [agentId])

  const open = (file: MemoryFileEntry) => {
    setOpened({ name: file.name, content: null, mtime: file.mtime })
    void fetchMyAgentMemoryFull(agentId, file.name)
      .then((read) =>
        setOpened((current) =>
          current?.name === file.name ? { name: file.name, content: read.content, mtime: read.mtime } : current
        )
      )
      .catch(() =>
        setOpened((current) =>
          current?.name === file.name ? { name: file.name, content: null, mtime: null, failed: true } : current
        )
      )
  }

  const notice = (text: string) => (
    <div className="px-4 py-6 font-sans text-[13px] font-normal leading-normal text-(--text-tertiary)">{text}</div>
  )

  return (
    <>
      <FileBrowserShell title={t('yourMemory')}>
        {listing.state === 'loading' ? (
          <div className="flex items-center justify-center py-10">
            <Spinner size={24} />
          </div>
        ) : listing.state === 'unavailable' ? (
          notice(t('yourMemoryUnavailable'))
        ) : listing.files.length === 0 ? (
          notice(t('yourMemoryEmpty'))
        ) : (
          <FileBrowserLayout
            resetKey={agentId}
            tree={(openPreview) =>
              listing.files.map((file) => (
                <FileBrowserRow
                  key={file.name}
                  icon="file-text"
                  name={file.name}
                  selected={opened?.name === file.name}
                  trailing={
                    <span className="flex-none font-sans text-[11px] font-normal leading-normal text-(--text-tertiary)">
                      {formatFileMtime(file.mtime)}
                    </span>
                  }
                  onClick={() => {
                    open(file)
                    openPreview()
                  }}
                />
              ))
            }
            preview={
              opened
                ? (onBack) => (
                    <>
                      <FileBrowserPreviewHeader
                        icon="file-text"
                        name={opened.name}
                        meta={
                          opened.content !== null
                            ? formatFileSize(new TextEncoder().encode(opened.content).length)
                            : undefined
                        }
                        onBack={onBack}
                      />
                      {opened.failed ? (
                        notice(t('yourMemoryUnavailable'))
                      ) : opened.content === null ? (
                        <div className="flex flex-1 items-center justify-center py-10">
                          <Spinner size={24} />
                        </div>
                      ) : (
                        <div className="max-h-[520px] overflow-auto px-[18px] py-4">
                          <MarkdownView content={opened.content} />
                        </div>
                      )}
                    </>
                  )
                : null
            }
          />
        )}
      </FileBrowserShell>
    </>
  )
}
