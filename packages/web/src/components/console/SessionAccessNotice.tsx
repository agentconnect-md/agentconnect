'use client'

import Link from 'next/link'
import type { SessionAccessIssue } from '@/lib/api'
import { useOrgs } from '@/lib/org-context'

const FEISHU_ADMIN_URL = {
  feishu: 'https://www.feishu.cn/admin',
  lark: 'https://www.larksuite.com/admin'
} as const

function feishuRegions(issues: readonly SessionAccessIssue[], reason: SessionAccessIssue['reason']) {
  const regions = new Set<keyof typeof FEISHU_ADMIN_URL>()
  for (const issue of issues) {
    if (
      issue.provider === 'feishu' &&
      issue.reason === reason &&
      (issue.region === 'feishu' || issue.region === 'lark')
    ) {
      regions.add(issue.region)
    }
  }
  return [...regions]
}

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

  const quotaRegions = feishuRegions(issues, 'quota')
  const authorizationRegions = feishuRegions(issues, 'authorization')
  const quotaNames = quotaRegions.map((region) => (region === 'feishu' ? 'Feishu' : 'Lark')).join(' and ')
  const authorizationNames = authorizationRegions
    .map((region) => (region === 'feishu' ? 'Feishu' : 'Lark'))
    .join(' and ')
  const message = quotaNames
    ? `${quotaNames} API quota is exhausted. ${impact === 'sessions' ? 'Affected sessions are hidden' : 'Usage from affected sessions is temporarily under-counted'} until an administrator increases the allowance or the monthly quota resets.`
    : authorizationNames
      ? `Your ${authorizationNames} sign-in ${authorizationRegions.length === 1 ? 'identity needs' : 'identities need'} to be refreshed. Refresh ${authorizationRegions.length === 1 ? 'it' : 'them'} in Profile to restore ${impact === 'sessions' ? 'access to affected sessions' : 'usage from affected sessions'}.`
      : impact === 'sessions'
        ? 'Some external access checks are unavailable. Affected sessions are hidden until access can be verified.'
        : 'Some external access checks are unavailable. Usage is temporarily under-counted rather than exposing inaccessible sessions.'
  const href =
    authorizationRegions.length === 1
      ? orgPath(`/profile?reauthorize=${authorizationRegions[0]}#sign-in-methods`)
      : orgPath('/profile#sign-in-methods')

  return (
    <div
      className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-(--status-paused) bg-(--status-paused-soft) px-3 py-2 font-sans text-[12px] font-medium leading-normal text-(--text-secondary) max-desktop:mx-4"
      role="status"
    >
      <span className="min-w-0 flex-1">{message}</span>
      {quotaRegions.map((region) => (
        <a key={region} className="lnk flex-none" href={FEISHU_ADMIN_URL[region]} rel="noreferrer" target="_blank">
          Open {region === 'feishu' ? 'Feishu' : 'Lark'} Admin
        </a>
      ))}
      {authorizationNames && quotaRegions.length === 0 ? (
        <Link className="lnk flex-none" href={href}>
          {authorizationRegions.length === 1 ? `Refresh ${authorizationNames}` : 'Open Profile'}
        </Link>
      ) : null}
    </div>
  )
}
