'use client'

import Link from 'next/link'
import type { SessionAccessIssue } from '@/lib/api'
import { useOrgs } from '@/lib/org-context'

export default function SessionAccessNotice({
  degraded,
  issues = [],
  impact
}: {
  degraded?: boolean
  issues?: SessionAccessIssue[]
  impact: 'sessions' | 'usage'
}) {
  const { orgPath } = useOrgs()
  if (!degraded) return null

  const regions = [
    ...new Set(
      issues.flatMap((issue) =>
        issue.provider === 'feishu' &&
        issue.reason === 'authorization' &&
        (issue.region === 'feishu' || issue.region === 'lark')
          ? [issue.region]
          : []
      )
    )
  ]
  const names = regions.map((region) => (region === 'feishu' ? 'Feishu' : 'Lark')).join(' and ')
  const message = names
    ? `Your ${names} ${regions.length === 1 ? 'authorization needs' : 'authorizations need'} attention. Reconnect ${regions.length === 1 ? 'it' : 'them'} in Profile to restore ${impact === 'sessions' ? 'access to affected sessions' : 'usage from affected sessions'}.`
    : impact === 'sessions'
      ? 'Some external access checks are unavailable. Affected sessions are hidden until access can be verified.'
      : 'Some external access checks are unavailable. Usage is temporarily under-counted rather than exposing inaccessible sessions.'
  const href =
    regions.length === 1
      ? orgPath(`/profile?reauthorize=${regions[0]}#sign-in-methods`)
      : orgPath('/profile#sign-in-methods')

  return (
    <div
      className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-(--status-paused) bg-(--status-paused-soft) px-3 py-2 font-sans text-[12px] font-medium leading-normal text-(--text-secondary) max-desktop:mx-4"
      role="status"
    >
      <span className="min-w-0 flex-1">{message}</span>
      {names ? (
        <Link className="lnk flex-none" href={href}>
          {regions.length === 1 ? `Reconnect ${names}` : 'Open Profile'}
        </Link>
      ) : null}
    </div>
  )
}
