'use client'

// A capability request in a conversation (capability-requests.md §4.4.2): the request page's own completion for someone with authority, the link and who can for anyone else.
import Link from 'next/link'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { fetchCapabilityRequest } from '@/lib/api'
import type { CapabilityCardBody } from '@/lib/data'
import { useOrgs } from '@/lib/org-context'
import { consoleKeys } from '@/lib/swr-keys'
import { CapabilityRequestCompletion } from '@/components/console/CapabilityRequestCompletion'
import { Icon } from '@/components/ui'

export function CapabilityRequestCard({ body }: { body: CapabilityCardBody }) {
  const t = useTranslations('CapabilityRequests')
  const { activeOrg, orgPath } = useOrgs()
  const href = orgPath(`/requests/${encodeURIComponent(body.requestId)}`)
  // A settled card is final text; only an open one reads the request, which also tells this viewer what they may do.
  const key = body.resolved ? null : consoleKeys.capabilityRequest(activeOrg?.id, body.requestId)
  const { data, mutate } = useSWR(key, ([, orgId, , id]) => fetchCapabilityRequest(id, orgId), {
    shouldRetryOnError: false
  })
  // A settled row's own text, else the wording of its status, else what the fetched request says.
  const settledText = body.resolved
    ? body.resolved.text || settledLine({ status: body.resolved.status, settledBy: null }, t)
    : data && data.status !== 'open'
      ? settledLine(data, t)
      : null

  return (
    <div data-capability-request={body.requestId} className="card flex max-w-[560px] flex-col gap-2 p-3">
      <div className="flex items-center gap-2 font-sans text-[12px] font-semibold uppercase leading-normal tracking-[0.04em] text-(--text-tertiary)">
        <Icon name="key-round" size={13} />
        <span>{t('page.crumb')}</span>
      </div>
      <div className="font-sans text-[14px] font-semibold leading-normal text-(--text-primary)">
        {data?.summary || body.summary}
      </div>
      {/* The agent's reason: untrusted, shown as plain text. */}
      <p className="m-0 whitespace-pre-wrap break-words text-[13px] leading-[1.5] text-(--text-secondary)">
        {data?.reason || body.reason}
      </p>
      {settledText ? (
        <p role="status" className="m-0 text-[13px] font-medium text-(--text-primary)">
          {settledText}
        </p>
      ) : data?.viewer.canComplete ? (
        <CapabilityRequestCompletion
          request={data}
          onSettled={(next) => void mutate(next, { revalidate: false })}
          onRefresh={() => void mutate()}
        />
      ) : (
        <div className="flex flex-col gap-1 text-[13px] text-(--text-secondary)">
          {data && data.viewer.whoCan.length > 0 && (
            <span>{t('card.whoCan', { names: data.viewer.whoCan.map((person) => person.name).join(', ') })}</span>
          )}
        </div>
      )}
      {!settledText && (
        <Link className="lnk text-[13px]" href={href}>
          {t('card.open')}
        </Link>
      )}
    </div>
  )
}

function settledLine(
  request: { status: string; settledBy: { name: string } | null },
  t: ReturnType<typeof useTranslations<'CapabilityRequests'>>
): string {
  // The request page's own wording for each outcome.
  const by = request.settledBy?.name
  if (request.status === 'completed') return by ? t('status.completed', { name: by }) : t('status.completedNoName')
  if (request.status === 'declined') return by ? t('status.declined', { name: by }) : t('status.declinedNoName')
  if (request.status === 'expired') return t('status.expired')
  return t('status.withdrawn')
}
