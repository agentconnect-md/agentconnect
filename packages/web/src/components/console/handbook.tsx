'use client'

// The Handbook, the organization record's three entries (assistant-mode.md §5.16): names, summaries, the research status and the file views.

import { useId, useState } from 'react'
import { useTranslations } from 'next-intl'
import { parseOrganizationFile, type FactLine, type FactSource } from '@agentconnect.md/protocol/organization-files'
import { fmtDate, type KnowledgeKind, type OrganizationRecordDto } from '@/lib/api'
import { agentLabel } from '@/lib/data'
import { useConsoleData } from '@/lib/data-context'
import { PlatformMark } from '@/components/marks'
import { Button, Icon } from '@/components/ui'
import { Scrim } from '@/components/console/Scrim'

export type RecordKind = Exclude<KnowledgeKind, 'entry'>
export const RECORD_KINDS: RecordKind[] = ['organization', 'channels', 'people']
const FILES: Record<RecordKind, 'organization.md' | 'channels.md' | 'members.md'> = {
  organization: 'organization.md',
  channels: 'channels.md',
  people: 'members.md'
}
export const HANDBOOK_ICONS: Record<RecordKind, string> = {
  organization: 'building',
  channels: 'hash',
  people: 'users'
}

export function isRecordKind(kind: KnowledgeKind): kind is RecordKind {
  return kind !== 'entry'
}

/** The entry's name as the console shows it: About, Channels, People. */
export function useRecordName(): (kind: RecordKind) => string {
  const t = useTranslations('Knowledge.handbook')
  return (kind) => t(`names.${kind}`)
}

/** About's first summary line, Channels' count of places, People's count of entries. */
export function useRecordSummary(): (kind: RecordKind, content: string) => string {
  const t = useTranslations('Knowledge.handbook')
  return (kind, content) => {
    const parsed = parseOrganizationFile(FILES[kind], content)
    if (!parsed.ok) return t('unreadable')
    const p = parsed.parsed
    if (p.file === 'organization.md') return p.facts[0]?.text.replace(/^\s*[-*]\s+/, '') ?? t('emptyAbout')
    if (p.file === 'channels.md') return t('places', { count: p.channels.length })
    return t('people', { count: p.entries.length })
  }
}

/** "Researched 17 Oct by Atlas", "Research running since 14:05", or "Not researched yet". */
export function useResearchStatus(): (research: OrganizationRecordDto['research']) => string {
  const t = useTranslations('Knowledge.handbook')
  const { agents } = useConsoleData()
  return (research) => {
    if (research.runningSince)
      return t('running', {
        since: new Date(research.runningSince).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      })
    if (!research.researchedAt) return t('notResearched')
    const agent = agents.find((candidate) => candidate.id === research.agentId)
    const day = fmtDate(research.researchedAt)
    return agent ? t('researchedBy', { day, name: agentLabel(agent) }) : t('researched', { day })
  }
}

/** A fact's source as a chip: a channel, a knowledge title, a repository, the person themself, or a web host. */
export function SourceChip({ source, date }: { source: FactSource; date: string }) {
  const t = useTranslations('Knowledge.handbook')
  const label =
    source.kind === 'channel'
      ? `#${source.name}`
      : source.kind === 'knowledge'
        ? source.title
        : source.kind === 'repository'
          ? [source.path, source.part].filter(Boolean).join(' ')
          : source.kind === 'self'
            ? t('self')
            : hostOf(source.url)
  return (
    <span className="inline-flex min-w-0 max-w-full items-center gap-[6px]">
      <span className="badge block min-w-0 max-w-[220px] truncate bg-(--surface-sunken) text-[10.5px] text-(--text-secondary)">
        {label}
      </span>
      <span className="flex-none font-mono text-[10.5px] font-normal leading-normal text-(--text-tertiary)">
        {date}
      </span>
    </span>
  )
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

function InferredTag() {
  const t = useTranslations('Knowledge.handbook')
  return (
    <span className="badge flex-none bg-(--surface-active) text-[10px] text-(--text-tertiary)">{t('inferred')}</span>
  )
}

/** One fact: its text, then its source chip and date, dimmed and tagged when inferred. */
function Fact({ fact, text }: { fact: FactLine; text?: string }) {
  return (
    <div
      className={
        fact.inferred
          ? 'flex flex-wrap items-baseline gap-x-2 gap-y-1 py-[5px] opacity-65'
          : 'flex flex-wrap items-baseline gap-x-2 gap-y-1 py-[5px]'
      }
    >
      <span className="min-w-0 flex-1 basis-[240px] font-sans text-[13px] font-normal leading-[1.55] text-(--text-primary)">
        {text ?? fact.text.replace(/^\s*[-*]\s+/, '')}
      </span>
      <SourceChip source={fact.source} date={fact.date} />
      {fact.inferred && <InferredTag />}
    </div>
  )
}

/** About by section: the summary first, then each section's lines. */
export function AboutView({ content }: { content: string }) {
  const t = useTranslations('Knowledge.handbook')
  const parsed = parseOrganizationFile('organization.md', content)
  if (!parsed.ok || parsed.parsed.file !== 'organization.md') return null
  const lines = content.split('\n')
  const sectionOf = (line: number) => {
    for (let at = line - 1; at >= 1; at--) {
      const heading = /^##\s+(.+?)\s*$/.exec(lines[at - 1] ?? '')
      if (heading) return heading[1]!
    }
    return ''
  }
  const groups = new Map<string, FactLine[]>()
  for (const fact of parsed.parsed.facts) {
    const section = sectionOf(fact.line)
    groups.set(section, [...(groups.get(section) ?? []), fact])
  }
  if (groups.size === 0) return <Empty text={t('emptyAbout')} />
  return (
    <div className="flex flex-col gap-4">
      {[...groups].map(([section, facts]) => (
        <section key={section || 'summary'}>
          <div className="mb-1 font-sans text-[11px] font-semibold uppercase leading-normal tracking-[0.04em] text-(--text-tertiary)">
            {section || t('summary')}
          </div>
          {facts.map((fact) => (
            <Fact key={fact.line} fact={fact} />
          ))}
        </section>
      ))}
    </div>
  )
}

/** Channels as a list: the platform mark, the name, the purpose and its source. */
export function ChannelsView({ content }: { content: string }) {
  const t = useTranslations('Knowledge.handbook')
  const { integrations } = useConsoleData()
  const parsed = parseOrganizationFile('channels.md', content)
  if (!parsed.ok || parsed.parsed.file !== 'channels.md') return null
  // The file names no platform; the mark shows when the organization chats on one platform alone.
  const platforms = [...new Set(integrations.map((integration) => integration.platform))]
  const platform = platforms.length === 1 ? platforms[0] : undefined
  if (parsed.parsed.channels.length === 0) return <Empty text={t('emptyChannels')} />
  return (
    <div className="flex flex-col">
      {parsed.parsed.channels.map((channel) => (
        <div
          key={channel.line}
          className="flex items-start gap-3 border-b border-(--border-subtle) py-[9px] last:border-b-0"
        >
          <span className="mt-[2px] flex h-5 w-5 flex-none items-center justify-center">
            {platform ? <PlatformMark platform={platform} /> : <Icon name="hash" size={14} />}
          </span>
          <div className="min-w-0 flex-1">
            <div className="font-sans text-[13px] font-semibold leading-normal text-(--text-primary)">
              #{channel.channel}
            </div>
            <Fact fact={channel} text={channel.text.replace(/^#[^:]*:\s*/, '')} />
          </div>
        </div>
      ))}
    </div>
  )
}

export interface PeopleActions {
  /** The caller's own keys; their card carries Edit and Remove. */
  ownKeys: string[]
  /** An organization owner edits and clears any card. */
  owner: boolean
  onEdit(key: string, text: string, own: boolean): void
  onRemove(key: string, own: boolean): void
}

/** People as cards: the name, handles and the four fields with their sources; controls only where the viewer may use them. */
export function PeopleView({ content, actions }: { content: string; actions?: PeopleActions }) {
  const t = useTranslations('Knowledge.handbook')
  const parsed = parseOrganizationFile('members.md', content)
  if (!parsed.ok || parsed.parsed.file !== 'members.md') return null
  if (parsed.parsed.entries.length === 0) return <Empty text={t('emptyPeople')} />
  const lines = content.split('\n')
  return (
    <div className="grid grid-cols-1 gap-3 desktop:grid-cols-2">
      {parsed.parsed.entries.map((entry) => {
        const own = !!entry.key && !!actions?.ownKeys.includes(entry.key)
        const editable = !!entry.key && (own || !!actions?.owner)
        const block = blockOf(lines, entry.line)
        return (
          <div key={entry.line} className="rounded-md border border-(--border-subtle) bg-(--surface-card) px-4 py-3">
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate font-sans text-[14px] font-semibold leading-normal text-(--text-primary)">
                    {entry.name}
                  </span>
                  {own && (
                    <span className="badge flex-none bg-(--brand-soft) text-[10px] text-(--brand-soft-text)">
                      {t('you')}
                    </span>
                  )}
                </div>
                <div className="truncate font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
                  {entry.handles.join(', ')}
                </div>
              </div>
              {editable && actions && (
                <div className="flex flex-none items-center gap-1">
                  <button
                    type="button"
                    className="iconbtn"
                    aria-label={t('edit')}
                    title={t('edit')}
                    onClick={() => actions.onEdit(entry.key!, block, own)}
                  >
                    <Icon name="pencil" size={14} />
                  </button>
                  <button
                    type="button"
                    className="iconbtn"
                    aria-label={own ? t('remove') : t('clear')}
                    title={own ? t('remove') : t('clear')}
                    onClick={() => actions.onRemove(entry.key!, own)}
                  >
                    <Icon name="trash" size={14} />
                  </button>
                </div>
              )}
            </div>
            <div className="mt-2 flex flex-col">
              {entry.facts.map((fact) => (
                <div key={fact.line} className="flex items-baseline gap-2">
                  <span className="w-[78px] flex-none font-sans text-[11px] font-medium leading-normal text-(--text-tertiary)">
                    {t(`fields.${FIELD_KEYS[fact.field]}`)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <Fact fact={fact} text={fact.text.replace(/^[^:]+:\s*/, '')} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}

const FIELD_KEYS = {
  Role: 'role',
  'Works on': 'worksOn',
  'Knows about': 'knowsAbout',
  'Ask about': 'askAbout'
} as const

/** One entry's text: its heading line and every line up to the next heading. */
function blockOf(lines: string[], line: number): string {
  const out = [lines[line - 1]!]
  for (let at = line; at < lines.length && !/^##\s/.test(lines[at]!); at++) out.push(lines[at]!)
  return out.join('\n').trim()
}

function Empty({ text }: { text: string }) {
  return (
    <div className="py-6 text-center font-sans text-[13px] font-normal leading-normal text-(--text-tertiary)">
      {text}
    </div>
  )
}

/** The memory file name an entry kind is parsed as. */
export function recordFile(kind: RecordKind): (typeof FILES)[RecordKind] {
  return FILES[kind]
}

/** A plain text editor for a record entry or one People card; the Control Plane names the failing line on a refusal. */
export function RecordTextEditor({
  title,
  initial,
  onClose,
  onSave
}: {
  title: string
  initial: string
  onClose: () => void
  onSave: (text: string) => Promise<void>
}) {
  const t = useTranslations('Knowledge.handbook')
  const titleId = useId()
  const [text, setText] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const save = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await onSave(text)
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setBusy(false)
    }
  }
  return (
    <Scrim onEscape={busy ? undefined : onClose} onClick={busy ? undefined : onClose}>
      <div
        className="modal max-w-[780px]"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modalhead">
          <span id={titleId} className="flex-1 font-sans text-[16px] font-semibold leading-normal">
            {title}
          </span>
          <button type="button" className="iconbtn" onClick={onClose} aria-label={t('close')}>
            <Icon name="x" size={16} />
          </button>
        </div>
        <div className="modalbody">
          <textarea
            className="inp mn min-h-[280px] w-full resize-y py-3"
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
          {error && <div className="mt-2 font-sans text-[12px] text-(--status-error)">{error}</div>}
        </div>
        <div className="modalfoot">
          <div className="flex-1" />
          <Button variant="ghost" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button variant="primary" disabled={busy} onClick={() => void save()}>
            {busy ? t('saving') : t('save')}
          </Button>
        </div>
      </div>
    </Scrim>
  )
}
