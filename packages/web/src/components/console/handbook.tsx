'use client'

// The Handbook, the organization record's three entries (assistant-mode.md §5.16): names, summaries, the research status and the file views.

import { useId, useState } from 'react'
import Link from 'next/link'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import {
  ORGANIZATION_SECTIONS,
  parseOrganizationFile,
  type ChannelLine,
  type FactLine,
  type FactSource
} from '@agentconnect.md/protocol/organization-files'
import {
  fmtDate,
  getOrganizationRecord,
  listOrganizationKnowledge,
  type KnowledgeKind,
  type OrganizationRecordDto
} from '@/lib/api'
import { agentLabel } from '@/lib/data'
import { chatPlaceName } from '@/lib/platform-labels'
import { useConsoleData } from '@/lib/data-context'
import { consoleKeys } from '@/lib/swr-keys'
import { useOrgs } from '@/lib/org-context'
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

/** About's first summary line, Channels' count of places and how many were read, People's count of entries. */
export function useRecordSummary(): (kind: RecordKind, content: string) => string {
  const t = useTranslations('Knowledge.handbook')
  return (kind, content) => {
    const parsed = parseOrganizationFile(FILES[kind], content)
    if (!parsed.ok) return t('unreadable')
    const p = parsed.parsed
    if (p.file === 'organization.md') return p.facts[0]?.text.replace(/^\s*[-*]\s+/, '') ?? t('emptyAbout')
    if (p.file === 'channels.md') {
      const read = p.channels.filter((channel) => !channel.inferred).length
      const places = t('places', { count: p.channels.length })
      return read < p.channels.length ? t('placesRead', { places, read }) : places
    }
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

/** A fact's source as a chip, with its date when given: a channel, a knowledge title, a repository, the person themself, or a web host. */
export function SourceChip({ source, date }: { source: FactSource; date?: string }) {
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
      {date && (
        <span className="flex-none font-mono text-[10.5px] font-normal leading-normal text-(--text-tertiary)">
          {date}
        </span>
      )}
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

/** One About line as the document shows it: its text and its source's footnote number. */
export interface AboutLine {
  line: number
  text: string
  note: number
}

/** One distinct source of About, numbered by first appearance, with how many lines cite it. */
export interface AboutSource {
  note: number
  source: FactSource
  lines: number
}

/** About as a document: the summary, each section's confirmed lines, the inferred lines apart, and the sources they cite. */
export interface AboutDocument {
  summary: AboutLine[]
  sections: { name: OrganizationSection; lines: AboutLine[] }[]
  unconfirmed: AboutLine[]
  sources: AboutSource[]
}

type OrganizationSection = (typeof ORGANIZATION_SECTIONS)[number]

/** About's text as a document, or null when it does not fit its shape. */
export function aboutDocument(content: string): AboutDocument | null {
  const parsed = parseOrganizationFile('organization.md', content)
  if (!parsed.ok || parsed.parsed.file !== 'organization.md') return null
  const lines = content.split('\n')
  const sectionOf = (line: number): OrganizationSection | undefined => {
    for (let at = line - 1; at >= 1; at--) {
      const heading = /^##\s+(.+?)\s*$/.exec(lines[at - 1] ?? '')
      if (heading) return heading[1] as OrganizationSection
    }
    return undefined
  }
  const summary: FactLine[] = []
  const sections = new Map<OrganizationSection, FactLine[]>()
  const unconfirmed: FactLine[] = []
  for (const fact of parsed.parsed.facts) {
    const section = sectionOf(fact.line)
    if (fact.inferred) unconfirmed.push(fact)
    else if (!section) summary.push(fact)
    else sections.set(section, [...(sections.get(section) ?? []), fact])
  }
  // Footnotes count up in reading order: the summary, the sections, then the lines not confirmed yet.
  const notes = new Map<string, AboutSource>()
  const toLine = (fact: FactLine): AboutLine => {
    const key = sourceKey(fact.source)
    const known = notes.get(key) ?? { note: notes.size + 1, source: fact.source, lines: 0 }
    known.lines++
    notes.set(key, known)
    return { line: fact.line, text: fact.text.replace(/^\s*[-*]\s+/, ''), note: known.note }
  }
  const summaryLines = summary.map(toLine)
  const sectionLines = [...sections].map(([name, facts]) => ({ name, lines: facts.map(toLine) }))
  const unconfirmedLines = unconfirmed.map(toLine)
  return { summary: summaryLines, sections: sectionLines, unconfirmed: unconfirmedLines, sources: [...notes.values()] }
}

// Two lines rest on one source when they name the same place, entry, repository or page.
function sourceKey(source: FactSource): string {
  if (source.kind === 'channel') return `channel:${placeKey(source.name)}`
  if (source.kind === 'knowledge') return `knowledge:${source.title.toLowerCase()}`
  if (source.kind === 'repository') return `repository:${source.path.toLowerCase()}`
  if (source.kind === 'web') return `web:${source.url.replace(/\/+$/, '')}`
  return 'self'
}

const SECTION_KEYS: Record<OrganizationSection, 'products' | 'howItWorks' | 'repositories'> = {
  'Products and customers': 'products',
  'How it works': 'howItWorks',
  'Repositories and systems': 'repositories'
}

/** Which source a footnote or a rail row points at while hovered or focused, shared by the document and its rail. */
export interface SourceFocus {
  active: number | null
  onActive: (note: number | null) => void
}

function Footnote({ note, focus }: { note: number; focus: SourceFocus }) {
  const t = useTranslations('Knowledge.handbook')
  return (
    <sup className="ml-[3px]">
      <a
        href={`#about-source-${note}`}
        aria-label={t('sourceNote', { note })}
        className={
          focus.active === note
            ? 'rounded-xs bg-(--brand-soft) px-[3px] font-mono text-[9.5px] font-medium text-(--brand-soft-text) no-underline'
            : 'rounded-xs bg-(--surface-sunken) px-[3px] font-mono text-[9.5px] font-medium text-(--text-tertiary) no-underline'
        }
        onMouseEnter={() => focus.onActive(note)}
        onMouseLeave={() => focus.onActive(null)}
        onFocus={() => focus.onActive(note)}
        onBlur={() => focus.onActive(null)}
      >
        {note}
      </a>
    </sup>
  )
}

function AboutBullets({ lines, focus, quiet }: { lines: AboutLine[]; focus: SourceFocus; quiet?: boolean }) {
  return (
    <ul className="m-0 flex list-disc flex-col gap-[5px] pl-5">
      {lines.map((line) => (
        <li
          key={line.line}
          className={
            quiet
              ? 'font-sans text-[13.5px] font-normal leading-[1.6] text-(--text-secondary)'
              : 'font-sans text-[13.5px] font-normal leading-[1.6] text-(--text-primary)'
          }
        >
          {line.text}
          <Footnote note={line.note} focus={focus} />
        </li>
      ))}
    </ul>
  )
}

/** About as a readable document: the summary as a paragraph, each section's lines, and what is not confirmed yet at the end. */
export function AboutView({ doc, focus }: { doc: AboutDocument; focus: SourceFocus }) {
  const t = useTranslations('Knowledge.handbook')
  if (doc.sources.length === 0) return <Empty text={t('emptyAbout')} />
  return (
    <div className="flex flex-col gap-5">
      {doc.summary.length > 0 && (
        <p className="m-0 font-sans text-[14px] font-normal leading-[1.65] text-(--text-primary)">
          {doc.summary.map((line, at) => (
            <span key={line.line}>
              {at > 0 && ' '}
              {line.text}
              <Footnote note={line.note} focus={focus} />
            </span>
          ))}
        </p>
      )}
      {doc.sections.map((section) => (
        <section key={section.name}>
          <h3 className="m-0 mb-2 font-sans text-[15px] font-semibold leading-normal text-(--text-primary)">
            {t(`sections.${SECTION_KEYS[section.name]}`)}
          </h3>
          <AboutBullets lines={section.lines} focus={focus} />
        </section>
      ))}
      {doc.unconfirmed.length > 0 && (
        <section className="rounded-md border border-dashed border-(--border-default) px-4 py-3">
          <h3 className="m-0 mb-2 flex items-baseline gap-2 font-sans text-[14px] font-semibold leading-normal text-(--text-primary)">
            {t('notConfirmed')}
            <span className="font-mono text-[11.5px] font-normal text-(--text-tertiary)">{doc.unconfirmed.length}</span>
          </h3>
          <AboutBullets lines={doc.unconfirmed} focus={focus} quiet />
        </section>
      )}
    </div>
  )
}

type SourceGroup = 'channel' | 'repository' | 'web' | 'knowledge' | 'self'
const SOURCE_GROUPS: SourceGroup[] = ['channel', 'repository', 'web', 'knowledge', 'self']

/** The sources rail beside About: each group with its count, each source with its footnote and how many lines cite it. */
export function AboutSourcesRail({ doc, focus }: { doc: AboutDocument; focus: SourceFocus }) {
  const t = useTranslations('Knowledge.handbook')
  const { activeOrg, orgPath } = useOrgs()
  const record = useSWR(consoleKeys.organizationRecord(activeOrg?.id), () => getOrganizationRecord())
  const library = useSWR(consoleKeys.organizationKnowledge(activeOrg?.id, false), () =>
    listOrganizationKnowledge(false)
  )
  // A channel source names no platform; the Channels entry's line for that place gives it and the name as the platform writes it.
  const channels = record.data?.entries.find((entry) => entry.kind === 'channels')
  const parsedChannels = channels ? parseOrganizationFile('channels.md', channels.content) : undefined
  const placeOf = new Map(
    parsedChannels?.ok && parsedChannels.parsed.file === 'channels.md'
      ? parsedChannels.parsed.channels.map((channel) => [placeKey(channel.channel), channel] as const)
      : []
  )
  const entryIdOf = (title: string) =>
    library.data?.find((entry) => entry.title.toLowerCase() === title.toLowerCase())?.id
  if (doc.sources.length === 0) return null
  return (
    <div className="card overflow-hidden">
      <div className="cardhead">
        <span className="cardtitle">{t('sourcesTitle')}</span>
      </div>
      {SOURCE_GROUPS.map((group) => {
        const sources = doc.sources.filter((entry) => entry.source.kind === group)
        if (sources.length === 0) return null
        return (
          <section key={group} className="border-t border-(--border-subtle) px-4 py-3 first-of-type:border-t-0">
            <div className="mb-1 flex items-center justify-between gap-2 font-sans text-[12.5px] font-medium leading-normal text-(--text-secondary)">
              {t(`sourceGroups.${group}`)}
              <span className="font-mono text-[11.5px] font-normal text-(--text-tertiary)">{sources.length}</span>
            </div>
            <div className="flex flex-col">
              {sources.map(({ note, source, lines }) => (
                <div
                  key={note}
                  id={`about-source-${note}`}
                  tabIndex={0}
                  className={
                    focus.active === note
                      ? '-mx-2 flex items-center gap-2 rounded-sm bg-(--surface-active) px-2 py-[5px] outline-none'
                      : '-mx-2 flex items-center gap-2 rounded-sm px-2 py-[5px] outline-none focus-visible:bg-(--surface-hover)'
                  }
                  onMouseEnter={() => focus.onActive(note)}
                  onMouseLeave={() => focus.onActive(null)}
                  onFocus={() => focus.onActive(note)}
                  onBlur={() => focus.onActive(null)}
                >
                  <span className="w-4 flex-none text-right font-mono text-[10.5px] font-semibold leading-normal text-(--text-tertiary)">
                    {note}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-sans text-[12.5px] font-normal leading-normal text-(--text-primary)">
                    <SourceLabel
                      source={source}
                      place={source.kind === 'channel' ? placeOf.get(placeKey(source.name)) : undefined}
                      href={source.kind === 'knowledge' ? entryIdOf(source.title) : undefined}
                      orgPath={orgPath}
                    />
                  </span>
                  <span
                    title={t('citedLines', { count: lines })}
                    className="flex-none font-mono text-[11.5px] font-normal leading-normal text-(--text-tertiary)"
                  >
                    {lines}
                  </span>
                </div>
              ))}
            </div>
          </section>
        )
      })}
    </div>
  )
}

function SourceLabel({
  source,
  place,
  href,
  orgPath
}: {
  source: FactSource
  place: ChannelLine | undefined
  href: string | undefined
  orgPath: (path: string) => string
}) {
  const t = useTranslations('Knowledge.handbook')
  if (source.kind === 'channel')
    return (
      <span className="inline-flex min-w-0 items-center gap-[6px]">
        <span className="flex h-4 w-4 flex-none items-center justify-center">
          {place ? <PlatformMark platform={place.platform} /> : <Icon name="hash" size={12} />}
        </span>
        <span className="truncate">{place ? chatPlaceName(place.platform, place.channel) : source.name}</span>
      </span>
    )
  if (source.kind === 'web')
    return (
      <a className="lnk" href={source.url} target="_blank" rel="noopener noreferrer" title={source.url}>
        {pageOf(source.url)}
      </a>
    )
  if (source.kind === 'knowledge')
    return href ? (
      <Link className="lnk" href={orgPath(`/knowledge/${href}`)}>
        {source.title}
      </Link>
    ) : (
      <>{source.title}</>
    )
  if (source.kind === 'repository') return <span className="font-mono text-[12px]">{source.path}</span>
  return <>{t('self')}</>
}

// A page as its host and path, without the scheme, a query or a trailing slash.
function pageOf(url: string): string {
  try {
    const at = new URL(url)
    return `${at.host}${at.pathname.replace(/\/+$/, '')}`
  } catch {
    return url
  }
}

/** Channels as a list: the places read first, then those not read yet; each row its platform mark, name, purpose and a source chip only when another place is the source. */
export function ChannelsView({ content }: { content: string }) {
  const t = useTranslations('Knowledge.handbook')
  const parsed = parseOrganizationFile('channels.md', content)
  if (!parsed.ok || parsed.parsed.file !== 'channels.md') return null
  const channels = parsed.parsed.channels
  if (channels.length === 0) return <Empty text={t('emptyChannels')} />
  const read = channels.filter((channel) => !channel.inferred)
  const notRead = channels.filter((channel) => channel.inferred)
  return (
    <div className="flex flex-col gap-4">
      {read.length > 0 && <ChannelRows channels={read} />}
      {notRead.length > 0 && (
        <section>
          <div className="mb-1 font-sans text-[11px] font-semibold uppercase leading-normal tracking-[0.04em] text-(--text-tertiary)">
            {t('notReadYet')}
          </div>
          <ChannelRows channels={notRead} />
        </section>
      )}
    </div>
  )
}

function ChannelRows({ channels }: { channels: ChannelLine[] }) {
  return (
    <div className="flex flex-col">
      {channels.map((channel) => (
        <div
          key={channel.line}
          title={channel.date}
          className="flex items-start gap-3 border-b border-(--border-subtle) py-[9px] last:border-b-0"
        >
          <span className="mt-px flex h-5 w-5 flex-none items-center justify-center">
            <PlatformMark platform={channel.platform} />
          </span>
          <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-1">
            <div className="min-w-0 flex-1 basis-[240px]">
              <div className="font-sans text-[13px] font-semibold leading-normal text-(--text-primary)">
                {chatPlaceName(channel.platform, channel.channel)}
              </div>
              <div className="font-sans text-[13px] font-normal leading-[1.55] text-(--text-secondary)">
                {channel.text}
              </div>
            </div>
            {!fromItself(channel) && <SourceChip source={channel.source} />}
          </div>
        </div>
      ))}
    </div>
  )
}

const placeKey = (name: string) => name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')

/** Whether a channel's purpose was read in that same place, which a chip would only repeat. */
function fromItself(channel: ChannelLine): boolean {
  return channel.source.kind === 'channel' && placeKey(channel.source.name) === placeKey(channel.channel)
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
