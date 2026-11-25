'use client'

import { useEffect, useId, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Icon } from '@/components/ui'

/** A bot seen posting in the conversation; `name` is null until the platform gave one. */
export interface BotSender {
  id: string
  name: string | null
  avatarUrl: string | null
}

/** What a typed query must look like to be added as a bare platform id: letters and digits with at least one digit. */
const BOT_ID = /^(?=.*\d)[A-Za-z0-9]{9,64}$/
const MAX_SUGGESTIONS = 5

/** Each sender's label: its name, with the id's tail where two senders share one, and the bare id for a nameless one. */
export function botSenderLabels(senders: readonly BotSender[]): Map<string, string> {
  const count = new Map<string, number>()
  for (const s of senders) if (s.name) count.set(s.name, (count.get(s.name) ?? 0) + 1)
  return new Map(
    senders.map((s) => [s.id, !s.name ? s.id : (count.get(s.name) ?? 0) > 1 ? `${s.name} · ${s.id.slice(-4)}` : s.name])
  )
}

function Mark({ sender }: { sender?: BotSender | undefined }) {
  const box = 'inline-flex h-[15px] w-[15px] flex-none items-center justify-center overflow-hidden rounded-[3px]'
  if (sender?.avatarUrl) return <img src={sender.avatarUrl} alt="" className={box} />
  return (
    <span className={`${box} bg-(--surface-active) text-(--text-tertiary)`}>
      <Icon name="bot" size={11} />
    </span>
  )
}

/** The bots a conversation ignores, as chips in one input that completes on the names of the bots seen there; a pick or a removal saves at once. */
export function IgnoredBotsInput({
  blocked,
  load,
  onChange,
  disabled = false
}: {
  blocked: readonly string[]
  /** The bots seen posting in the conversation. */
  load: () => Promise<BotSender[]>
  /** Saves the whole list; a rejection's message is shown under the input. */
  onChange: (next: string[]) => Promise<void>
  disabled?: boolean
}) {
  const t = useTranslations('Integrations.channelList.ignoredBots')
  const id = useId()
  const [senders, setSenders] = useState<BotSender[]>([])
  const [query, setQuery] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    // A failed read leaves the list empty: ids still show, and an id can still be added.
    void load().then(
      (rows) => live && setSenders(rows),
      () => undefined
    )
    return () => {
      live = false
    }
  }, [])

  const byId = useMemo(() => new Map(senders.map((s) => [s.id, s])), [senders])
  const labels = useMemo(() => botSenderLabels(senders), [senders])
  const q = query.trim()
  const suggestions = useMemo(() => {
    if (!q) return []
    const needle = q.toLocaleLowerCase()
    return senders
      .filter((s) => !blocked.includes(s.id))
      .filter((s) => s.id === q || (s.name ?? '').toLocaleLowerCase().includes(needle))
      .slice(0, MAX_SUGGESTIONS)
  }, [q, senders, blocked])
  // A bare id is offered only where no seen bot answers the query, so a known bot is never added twice.
  const addId = suggestions.length === 0 && BOT_ID.test(q) && !blocked.includes(q) ? q : null

  const save = (next: string[]) => {
    if (disabled || saving) return
    setError(null)
    setSaving(true)
    void onChange(next)
      .then(() => setQuery(''))
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setSaving(false))
  }
  const add = (senderId: string) => save([...blocked, senderId])
  const remove = (senderId: string) => save(blocked.filter((b) => b !== senderId))
  const first = suggestions[0]?.id ?? addId

  return (
    <div className="px-3 pb-1 desktop:px-[10px]">
      <div
        id={`${id}-label`}
        className="pb-[6px] pt-[7px] font-sans text-[10px] font-semibold uppercase leading-normal tracking-[0.06em] text-(--text-tertiary) desktop:pb-[5px] desktop:pt-[6px]"
      >
        {t('label')}
      </div>
      <div className="flex min-h-9 flex-wrap items-center gap-1 rounded-sm border border-(--border-default) bg-(--surface-card) px-1 py-[3px] focus-within:border-(--border-strong) focus-within:shadow-(--focus-ring) desktop:min-h-[30px]">
        {blocked.map((senderId) => {
          const sender = byId.get(senderId)
          const label = labels.get(senderId) ?? senderId
          return (
            <span
              key={senderId}
              className="inline-flex max-w-full items-center gap-1 rounded-xs bg-(--surface-hover) py-[2px] pl-[3px] pr-1 text-[12px] text-(--text-primary)"
            >
              <Mark sender={sender} />
              <span className={`min-w-0 truncate ${sender?.name ? '' : 'font-mono text-[11px]'}`}>{label}</span>
              <button
                type="button"
                disabled={disabled || saving}
                aria-label={t('remove', { name: label })}
                onClick={() => remove(senderId)}
                className="inline-flex flex-none cursor-pointer items-center text-(--text-tertiary) hover:text-(--text-primary) focus-visible:shadow-(--focus-ring) focus-visible:outline-none"
              >
                <Icon name="x" size={11} strokeWidth={2.2} />
              </button>
            </span>
          )
        })}
        <input
          type="text"
          value={query}
          disabled={disabled || saving}
          aria-labelledby={`${id}-label`}
          aria-controls={`${id}-list`}
          autoComplete="off"
          spellCheck={false}
          placeholder={blocked.length === 0 ? t('placeholder') : ''}
          onChange={(e) => {
            setError(null)
            setQuery(e.target.value)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && first) {
              e.preventDefault()
              add(first)
            } else if (e.key === 'Backspace' && !query && blocked.length > 0) {
              remove(blocked[blocked.length - 1]!)
            }
          }}
          className="h-6 min-w-[60px] flex-1 border-0 bg-transparent px-1 font-sans text-[12px] text-(--text-primary) outline-none placeholder:text-(--text-tertiary)"
        />
      </div>
      <div id={`${id}-list`} role="listbox" aria-labelledby={`${id}-label`}>
        {(suggestions.length > 0 || addId) && (
          <div className="mt-1 overflow-hidden rounded-sm border border-(--border-subtle)">
            {suggestions.map((s, i) => (
              <button
                key={s.id}
                type="button"
                role="option"
                aria-selected={i === 0}
                onClick={() => add(s.id)}
                className={`flex w-full cursor-pointer items-center gap-[6px] px-2 py-[6px] text-left text-[12px] text-(--text-primary) hover:bg-(--surface-hover) ${i === 0 ? 'bg-(--surface-hover)' : ''}`}
              >
                <Mark sender={s} />
                <span className="min-w-0 truncate">{labels.get(s.id)}</span>
              </button>
            ))}
            {addId && (
              <button
                type="button"
                role="option"
                aria-selected
                onClick={() => add(addId)}
                className="flex w-full cursor-pointer items-center gap-[6px] bg-(--surface-hover) px-2 py-[6px] text-left text-[12px] text-(--text-primary)"
              >
                <Icon name="plus" size={12} color="var(--text-tertiary)" />
                <span className="min-w-0 truncate">
                  {t.rich('addId', {
                    id: addId,
                    code: (chunks) => <span className="font-mono text-[11px]">{chunks}</span>
                  })}
                </span>
              </button>
            )}
          </div>
        )}
      </div>
      {error && (
        <div role="alert" className="mt-[6px] break-words text-[11.5px] leading-[1.45] text-(--status-error)">
          {error}
        </div>
      )}
    </div>
  )
}
