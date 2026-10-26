'use client'

// A capability request's page (capability-requests.md §4.5): who asked and why, what changes, and the console dialog that makes it.
import { useEffect, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import useSWR from 'swr'
import { useFormatter, useTranslations } from 'next-intl'
import {
  declineCapabilityRequest,
  fetchCapabilityRequest,
  forwardCapabilityRequest,
  reopenCapabilityRequest,
  type CapabilityRequestDto,
  type CapabilityRequestOriginDto
} from '@/lib/api'
import {
  askedBy,
  askerName,
  capabilityDiff,
  CAPABILITY_NOTE_MAX,
  type CapabilityDiffLine
} from '@/lib/capability-requests'
import { formatDateTime } from '@/i18n/format'
import { useOrgs } from '@/lib/org-context'
import { consoleKeys } from '@/lib/swr-keys'
import { useCrumbSlot } from '@/components/console/Shell'
import { CapabilityRequestCompletion } from '@/components/console/CapabilityRequestCompletion'
import { LoadingState } from '@/components/marks'
import { Button, Icon } from '@/components/ui'

type Translate = ReturnType<typeof useTranslations<'CapabilityRequests'>>

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))
const sectionTitle =
  'mb-2 font-sans text-[12px] font-semibold uppercase leading-normal tracking-[0.04em] text-(--text-tertiary)'

export default function CapabilityRequestView() {
  const t = useTranslations('CapabilityRequests')
  const { id } = useParams<{ id: string }>()
  const { activeOrg, orgPath } = useOrgs()
  const { register: registerCrumb } = useCrumbSlot()
  const title = t('page.crumb')
  useEffect(() => {
    registerCrumb({ id, title, status: '', statusLabel: '' })
    return () => registerCrumb(null)
  }, [registerCrumb, id, title])

  const key = consoleKeys.capabilityRequest(activeOrg?.id, id)
  const { data, error, mutate } = useSWR(key, ([, orgId, , requestId]) => fetchCapabilityRequest(requestId, orgId))

  if (!data) {
    return (
      <div className="wrap px-4 pt-[14px] desktop:p-0">
        {error ? (
          <div className="card flex flex-col items-start gap-2 p-5">
            <span className="font-sans text-[15px] font-semibold leading-normal">{t('page.notFound')}</span>
            <span className="text-[13px] text-(--text-secondary)">{t('page.notFoundBody')}</span>
            <Link className="lnk text-[13px]" href={orgPath('/home')}>
              {t('page.backHome')}
            </Link>
          </div>
        ) : (
          <LoadingState fill />
        )}
      </div>
    )
  }
  return <CapabilityRequestBody request={data} onChange={(next) => void mutate(next, { revalidate: false })} />
}

/** The loaded request; split out so tests render it from a DTO without the route. */
export function CapabilityRequestBody({
  request,
  onChange
}: {
  request: CapabilityRequestDto
  onChange: (next: CapabilityRequestDto) => void
}) {
  const t = useTranslations('CapabilityRequests')
  const format = useFormatter()
  const { orgPath } = useOrgs()
  const people = askedBy(request)
  const first = request.origins[0]
  const when = (iso: string) => formatDateTime(format, new Date(iso), { dateStyle: 'medium', timeStyle: 'short' })
  const open = request.status === 'open'

  return (
    <div className="wrap px-4 pt-[14px] desktop:p-0">
      <div className="flex flex-col gap-1">
        <span className="eyebrow">{t('page.crumb')}</span>
        <h1 className="ptitle">{t('page.heading', { agent: request.agentName })}</h1>
        <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-(--text-secondary)">
          <Link className="lnk font-mono text-[12px]" href={orgPath(`/agents/${request.agentId}`)}>
            {request.agentName}
          </Link>
          <span>
            {people.length > 0
              ? t('page.askedBy', { people: people.map(askerName).join(', ') })
              : t('page.askedByNobody')}
          </span>
          {first && <OriginPlace origin={first} t={t} />}
          <span>{t('page.askedAt', { time: when(request.createdAt) })}</span>
          {open && <span>{t('page.expiresAt', { time: when(request.expiresAt) })}</span>}
        </div>
      </div>

      <div className="card mt-5 p-4">
        <div className={sectionTitle}>{t('page.agentSays')}</div>
        {/* The reason is the agent's own words: untrusted, so it is shown as plain text and nothing in it is rendered. */}
        <p data-reason className="whitespace-pre-wrap break-words text-[14px] leading-[1.55] text-(--text-primary)">
          {request.reason}
        </p>
      </div>

      <div className="card mt-4 p-4">
        <div className={sectionTitle}>{t('page.whatChanges')}</div>
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {capabilityDiff(request).map((line, index) => (
            <li key={index} className="text-[14px] leading-[1.5]">
              <DiffLine line={line} t={t} />
            </li>
          ))}
        </ul>
        {request.warnings.length > 0 && (
          <ul className="m-0 mt-3 flex list-none flex-col gap-1 p-0">
            {request.warnings.map((warning) => (
              <li
                key={warning}
                role="note"
                className="flex items-start gap-2 text-[13px] leading-[1.5] text-(--text-primary)"
              >
                <Icon name="triangle-alert" size={14} color="var(--status-paused)" className="mt-[3px] flex-none" />
                <span>{warning}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <RequestState request={request} t={t} when={when} />

      {open && request.viewer.canComplete && (
        <div className="card mt-4 p-4">
          <div className={sectionTitle}>{t('complete.heading')}</div>
          <CapabilityRequestCompletion request={request} onSettled={onChange} />
        </div>
      )}
      {open && !request.viewer.canComplete && <NoAuthority request={request} t={t} />}
      {(open && request.viewer.canDecline) || (request.status === 'declined' && request.viewer.canReopen) ? (
        <DeclineOrReopen request={request} onChange={onChange} t={t} />
      ) : null}
    </div>
  )
}

function OriginPlace({ origin, t }: { origin: CapabilityRequestOriginDto; t: Translate }) {
  const { orgPath } = useOrgs()
  // An external place's details stay out of this view (§4.4.5).
  if (origin.external) return <span>{t('page.externalPlace')}</span>
  return (
    <Link className="lnk text-[13px]" href={orgPath(`/sessions/${encodeURIComponent(origin.sessionId)}`)}>
      {origin.placeLabel ?? t('page.openConversation')}
    </Link>
  )
}

function settingValue(value: string | boolean | null, t: Translate): string {
  if (value === null) return t('page.valueDefault')
  if (typeof value === 'boolean') return value ? t('page.valueOn') : t('page.valueOff')
  return value
}

const code = (chunks: ReactNode) => <code className="mono text-[12.5px]">{chunks}</code>
const name = (chunks: ReactNode) => <span className="font-semibold">{chunks}</span>

function DiffLine({ line, t }: { line: CapabilityDiffLine; t: Translate }) {
  if (line.kind === 'setting') {
    return (
      <>
        {t.rich('page.settingChange', {
          field: t(`fields.${line.field}`),
          from: settingValue(line.from, t),
          to: settingValue(line.to, t),
          code
        })}
      </>
    )
  }
  if (line.kind === 'mcp-server') {
    return (
      <span className="flex flex-wrap items-center gap-2">
        <span>{t.rich('page.addServer', { server: line.server, name })}</span>
        {line.already && (
          <span className="badge bg-(--surface-active) text-(--text-secondary)">{t('page.serverAlready')}</span>
        )}
        {!line.exists && <span className="text-[13px] text-(--text-secondary)">{t('page.serverMissing')}</span>}
      </span>
    )
  }
  return (
    <span className="flex flex-wrap items-center gap-2">
      <span>{t.rich('page.installSkill', { skill: line.skill, name })}</span>
      {line.already && (
        <span className="badge bg-(--surface-active) text-(--text-secondary)">{t('page.skillAlready')}</span>
      )}
    </span>
  )
}

function statusLine(request: CapabilityRequestDto, t: Translate): string {
  const by = request.settledBy?.name
  switch (request.status) {
    case 'open':
      return t('status.open')
    case 'completed':
      return by ? t('status.completed', { name: by }) : t('status.completedNoName')
    case 'declined':
      return by ? t('status.declined', { name: by }) : t('status.declinedNoName')
    case 'expired':
      return t('status.expired')
    case 'withdrawn':
      return t('status.withdrawn')
  }
}

function wakeLine(origin: CapabilityRequestOriginDto, t: Translate): string | null {
  if (origin.wake === 'delivered') return t('wake.delivered')
  if (origin.wake === 'gone') return t('wake.gone')
  if (origin.wake === 'pending') return origin.wakeReason === 'paused' ? t('wake.paused') : t('wake.pending')
  return null
}

function RequestState({
  request,
  t,
  when
}: {
  request: CapabilityRequestDto
  t: Translate
  when: (iso: string) => string
}) {
  const settled = request.status !== 'open'
  const wakes = request.origins.flatMap((origin) => {
    const line = wakeLine(origin, t)
    return line ? [{ origin, line }] : []
  })
  return (
    <div className="card mt-4 p-4" data-status={request.status}>
      <div className="flex flex-wrap items-center gap-2 font-sans text-[14px] font-semibold leading-normal">
        <span>{statusLine(request, t)}</span>
        {settled && request.settledAt && (
          <span className="font-mono text-[12px] font-normal text-(--text-tertiary)">{when(request.settledAt)}</span>
        )}
      </div>
      {request.status === 'completed' && request.outcome && (
        <p className="mt-2 text-[13px] text-(--text-secondary)">{t('status.outcome', { outcome: request.outcome })}</p>
      )}
      {request.status === 'declined' && request.note && (
        <div className="mt-2 text-[13px] text-(--text-secondary)">
          <span>{t('status.note')}</span>{' '}
          <q className="whitespace-pre-wrap break-words text-(--text-primary)">{request.note}</q>
        </div>
      )}
      {request.origins.length > 1 && (
        <div className="mt-3">
          <div className={sectionTitle}>{t('page.conversations')}</div>
          <ul className="m-0 flex list-none flex-col gap-1 p-0 text-[13px]">
            {request.origins.map((origin) => (
              <li key={origin.sessionId} className="flex flex-wrap items-center gap-x-3">
                <OriginPlace origin={origin} t={t} />
                <span className="text-(--text-tertiary)">
                  {origin.askers.length > 0 ? origin.askers.map(askerName).join(', ') : t('page.askedByNobody')}
                </span>
                {wakeLine(origin, t) && <span className="text-(--text-secondary)">{wakeLine(origin, t)}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {request.origins.length === 1 && settled && wakes[0] && (
        <p className="mt-2 text-[13px] text-(--text-secondary)">{wakes[0].line}</p>
      )}
    </div>
  )
}

function NoAuthority({ request, t }: { request: CapabilityRequestDto; t: Translate }) {
  const { whoCan, missing, canForward } = request.viewer
  const [target, setTarget] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const forward = async () => {
    setBusy(true)
    setError(null)
    try {
      const sent = await forwardCapabilityRequest(request.id, target || undefined, request.orgId)
      setResult(sent.forwarded === 'dm' ? t('authority.forwardedDm') : t('authority.forwardedActivity'))
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="card mt-4 p-4" data-no-authority>
      <div className="font-sans text-[14px] font-semibold leading-normal">{t('authority.heading')}</div>
      {missing && <p className="mt-2 text-[13px] text-(--text-secondary)">{t('authority.needs', { missing })}</p>}
      <p className="mt-1 text-[13px] text-(--text-secondary)">
        {whoCan.length > 0
          ? t('authority.whoCan', { names: whoCan.map((person) => person.name).join(', ') })
          : t('authority.nobodyCan')}
      </p>
      {canForward && whoCan.length > 0 && !result && (
        <div className="mt-3 flex flex-col gap-2 desktop:flex-row desktop:items-end">
          <label className="fld m-0 desktop:w-[260px]">
            <span className="fldlbl">{t('authority.forwardTo')}</span>
            <select className="inp" value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value="">{t('authority.forwardAnyone')}</option>
              {whoCan.map((person) => (
                <option key={person.userId} value={person.userId}>
                  {person.name}
                </option>
              ))}
            </select>
          </label>
          <Button variant="secondary" disabled={busy} onClick={() => void forward()}>
            {t('authority.forward')}
          </Button>
        </div>
      )}
      {result && (
        <p role="status" className="mt-3 text-[13px] text-(--text-secondary)">
          {result}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-3 text-[13px] text-(--red-600)">
          {error}
        </p>
      )}
    </div>
  )
}

function DeclineOrReopen({
  request,
  onChange,
  t
}: {
  request: CapabilityRequestDto
  onChange: (next: CapabilityRequestDto) => void
  t: Translate
}) {
  const [declining, setDeclining] = useState(false)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = async (action: () => Promise<CapabilityRequestDto>) => {
    setBusy(true)
    setError(null)
    try {
      onChange(await action())
      setDeclining(false)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  if (request.status === 'declined') {
    return (
      <div className="mt-4 flex flex-col gap-2">
        <div>
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => void run(() => reopenCapabilityRequest(request.id, request.orgId))}
          >
            {t('decline.reopen')}
          </Button>
        </div>
        {error && (
          <p role="alert" className="text-[13px] text-(--red-600)">
            {error}
          </p>
        )}
      </div>
    )
  }
  return (
    <div className="mt-4 flex flex-col gap-2">
      {declining ? (
        <div className="card flex flex-col gap-3 p-4">
          <label className="fld m-0">
            <span className="fldlbl">{t('decline.note')}</span>
            <textarea
              className="inp min-h-15 resize-y px-3 py-2 leading-[1.5]"
              maxLength={CAPABILITY_NOTE_MAX}
              placeholder={t('decline.placeholder')}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="danger"
              disabled={busy}
              onClick={() =>
                void run(() => declineCapabilityRequest(request.id, note.trim() || undefined, request.orgId))
              }
            >
              {t('decline.confirm')}
            </Button>
            <Button variant="secondary" disabled={busy} onClick={() => setDeclining(false)}>
              {t('decline.cancel')}
            </Button>
          </div>
        </div>
      ) : (
        <div>
          <Button variant="ghost" disabled={busy} onClick={() => setDeclining(true)}>
            {t('decline.action')}
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="text-[13px] text-(--red-600)">
          {error}
        </p>
      )}
    </div>
  )
}
