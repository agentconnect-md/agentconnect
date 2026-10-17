'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import dynamic from 'next/dynamic'
import {
  clearAgentDirectoryEntry,
  clearMyAgentDirectoryEntry,
  fetchAgentDirectoryEntries,
  fetchMyAgentDirectoryEntry,
  type DirectoryEntriesDto,
  type MyDirectoryEntriesDto
} from '@/lib/api'
import { Button } from '@/components/ui'
import { ConfirmationDialog } from '@/components/console/ConfirmationDialog'

// Loaded lazily like the other memory views so react-markdown never ships in the main console bundle.
const MarkdownView = dynamic(() => import('@/components/console/MarkdownView'), {
  ssr: false,
  loading: () => <p className="text-(--text-tertiary)">{'Loading…'}</p>
})

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

// The signed-in user's own entry in the people directory, with their Clear; nothing when the agent keeps none.
export function MyDirectoryEntry({ agentId }: { agentId: string }) {
  const t = useTranslations('Agents.detail.memory')
  const [mine, setMine] = useState<MyDirectoryEntriesDto | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    setMine(null)
    void fetchMyAgentDirectoryEntry(agentId)
      .then((page) => {
        if (live) setMine(page)
      })
      .catch(() => {
        if (live) setMine(null)
      })
    return () => {
      live = false
    }
  }, [agentId])

  if (!mine || mine.entries.length === 0) return null

  const clear = async () => {
    setClearing(true)
    setError(null)
    try {
      await clearMyAgentDirectoryEntry(agentId)
      setMine({ ...mine, entries: [] })
      setConfirming(false)
    } catch (e) {
      setError(message(e))
    } finally {
      setClearing(false)
    }
  }

  return (
    <section data-my-directory-entry className="card mb-4 overflow-hidden max-desktop:rounded-lg">
      <div className="flex items-center justify-between gap-3 border-b border-(--border-subtle) px-4 py-3">
        <span className="font-sans text-[13px] font-semibold leading-normal">{t('yourDirectoryEntry')}</span>
        {mine.clearable ? (
          <Button
            variant="danger"
            size="xs"
            onClick={() => {
              setError(null)
              setConfirming(true)
            }}
          >
            {t('clearEntry')}
          </Button>
        ) : null}
      </div>
      <div className="max-h-[320px] overflow-auto px-[18px] py-4">
        <MarkdownView content={mine.entries.map((entry) => entry.text).join('\n\n')} />
      </div>
      {confirming ? (
        <ConfirmationDialog
          title={t('clearYourEntryTitle')}
          confirmLabel={t('clearEntry')}
          busyLabel={t('clearingLayer')}
          destructive
          busy={clearing}
          error={error}
          onClose={() => {
            if (!clearing) setConfirming(false)
          }}
          onConfirm={() => void clear()}
        >
          <p className="m-0">{t('clearYourEntryBody')}</p>
        </ConfirmationDialog>
      ) : null}
    </section>
  )
}

// An organization owner's list of the directory's people, each with a Clear; nothing for anyone else.
export function DirectoryOwnerEntries({ agentId }: { agentId: string }) {
  const t = useTranslations('Agents.detail.memory')
  const [page, setPage] = useState<DirectoryEntriesDto | null>(null)
  const [confirming, setConfirming] = useState<{ key: string; name: string } | null>(null)
  const [clearing, setClearing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    setPage(null)
    void fetchAgentDirectoryEntries(agentId)
      .then((next) => {
        if (live) setPage(next)
      })
      .catch(() => {
        if (live) setPage(null)
      })
    return () => {
      live = false
    }
  }, [agentId])

  if (!page?.clearable || page.entries.length === 0) return null

  const clear = async () => {
    if (!confirming) return
    setClearing(true)
    setError(null)
    try {
      await clearAgentDirectoryEntry(agentId, confirming.key)
      setPage({ ...page, entries: page.entries.filter((entry) => entry.key !== confirming.key) })
      setConfirming(null)
    } catch (e) {
      setError(message(e))
    } finally {
      setClearing(false)
    }
  }

  return (
    <section data-directory-entries className="card mt-4 overflow-hidden max-desktop:rounded-lg">
      <div className="border-b border-(--border-subtle) px-4 py-3 font-sans text-[13px] font-semibold leading-normal">
        {t('directoryPeople')}
      </div>
      {page.entries.map((entry) => (
        <div
          key={entry.key}
          className="flex items-center justify-between gap-3 border-b border-(--border-subtle) px-4 py-2 last:border-b-0"
        >
          <span className="min-w-0 truncate font-sans text-[13px] font-normal leading-normal">{entry.name}</span>
          <Button
            variant="secondary"
            size="xs"
            onClick={() => {
              setError(null)
              setConfirming(entry)
            }}
          >
            {t('clearEntry')}
          </Button>
        </div>
      ))}
      {confirming ? (
        <ConfirmationDialog
          title={t('clearEntryTitle')}
          confirmLabel={t('clearEntry')}
          busyLabel={t('clearingLayer')}
          destructive
          busy={clearing}
          error={error}
          onClose={() => {
            if (!clearing) setConfirming(null)
          }}
          onConfirm={() => void clear()}
        >
          <p className="m-0">{t('clearEntryBody', { name: confirming.name })}</p>
        </ConfirmationDialog>
      ) : null}
    </section>
  )
}
