'use client'

// The agent's OWN GitLab face (gitlab-com-integration.md §18.1): the bot account
// it posts, reviews, and pushes as. One account per top-level group the agent has
// a bound project in — GitLab bot accounts cannot be invited across that boundary
// — so an agent spanning two groups shows two, grouped. Nothing here is an input:
// the name derives from the agent, and the card is absent until a project is bound.

import useSWR from 'swr'
import { GitlabMark } from '@/components/marks'
import { MOCK_MODE } from '@/lib/data'
import { useOrgs } from '@/lib/org-context'
import { consoleKeys } from '@/lib/swr-keys'
import { GITLAB_PROJECT_STATE, gitlabProfileUrl, gitlabStateReasonText } from '@/lib/gitlab-projects'
import { fetchGitlabAgentAccounts, type GitlabAgentAccountDto } from '@/lib/api'

type AccountsRead = Awaited<ReturnType<typeof fetchGitlabAgentAccounts>>

/** Account convergence runs behind hook CRUD; this is how often we ask whether it landed. */
const CONVERGENCE_POLL_MS = 5_000

/** Accounts in row order, one bucket per group — the readable path labels it whenever we have one. */
function groupByRoot(accounts: readonly GitlabAgentAccountDto[]): Array<{
  rootGroupId: string
  label: string
  accounts: GitlabAgentAccountDto[]
}> {
  const groups: Array<{ rootGroupId: string; label: string; accounts: GitlabAgentAccountDto[] }> = []
  for (const account of accounts) {
    const found = groups.find((g) => g.rootGroupId === account.rootGroupId)
    if (found) {
      found.accounts.push(account)
      if (account.rootGroupPath) found.label = account.rootGroupPath
      continue
    }
    groups.push({
      rootGroupId: account.rootGroupId,
      label: account.rootGroupPath ?? `group ${account.rootGroupId}`,
      accounts: [account]
    })
  }
  return groups
}

/** One account chip. The username is deterministic, so the profile links only once the account exists. */
function AccountChip({ account }: { account: GitlabAgentAccountDto }) {
  const state = GITLAB_PROJECT_STATE[account.state]
  const reason = gitlabStateReasonText(account.stateReason)
  const handle = `bot @${account.username}`
  return (
    <div data-gitlab-account={account.id} className="px-4 py-3 desktop:px-[14px]">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-[6px]">
        {account.userId ? (
          <a
            href={gitlabProfileUrl(account.username)}
            target="_blank"
            rel="noopener noreferrer"
            className="mono min-w-0 truncate text-[12.5px] text-(--text-primary) hover:underline"
          >
            {handle}
          </a>
        ) : (
          <span className="mono min-w-0 truncate text-[12.5px] text-(--text-tertiary)">{handle}</span>
        )}
        <span className={`badge flex-none ${state.badge}`}>{state.label}</span>
        {account.lifecycle === 'retiring' && (
          <span className="badge flex-none bg-(--surface-active) text-(--text-tertiary)">removing</span>
        )}
      </div>
      {account.displayName && (
        <div className="mt-[3px] font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
          Shown on GitLab as {account.displayName}
        </div>
      )}
      {reason && (
        <div className="mt-[3px] font-sans text-[11.5px] font-normal leading-[1.45] text-(--text-secondary)">
          {reason}
        </div>
      )}
    </div>
  )
}

/** The top-level groups a set of consumed project paths implies — one bot account each (§7.2).
 *  A GitLab project always sits under a group, so the leading path segment IS that group. */
function rootGroupsOf(projectPaths: readonly string[]): string[] {
  return [...new Set(projectPaths.map((path) => path.split('/')[0]).filter((seg): seg is string => !!seg))].sort()
}

/** Whether the fetched accounts already match what the consumers imply, with nothing transient left.
 *  Counting GROUPS, not consumers: two projects in one group share one account, two groups earn two. */
function settled(data: AccountsRead | undefined, expectedGroups: number): boolean {
  if (!data) return false
  if (data.accounts.length !== expectedGroups) return false
  // A refused account rests here on purpose: a group out of service accounts needs a repair, not a poll.
  return data.accounts.every((a) => a.lifecycle === 'active' && a.state !== 'provisioning')
}

export function AgentGitlabIdentity({
  agentId,
  consumerProjectPaths,
  className = ''
}: {
  agentId: string
  /** Paths of the projects this agent consumes: its enabled GitLab hooks plus a GitLab workspace. */
  consumerProjectPaths: readonly string[]
  className?: string
}) {
  const { activeOrg } = useOrgs()
  const rootGroups = rootGroupsOf(consumerProjectPaths)
  // The consumer set is part of the key, so binding or unbinding a project makes the entry
  // recorded under the old set unreachable and no mutation site has to invalidate it.
  const signature = `${consumerProjectPaths.length}:${rootGroups.join(',')}`
  const accountsKey = MOCK_MODE ? null : consoleKeys.agentGitlabAccounts(activeOrg?.id, agentId, signature)
  const { data } = useSWR(accountsKey, ([, , , id]) => fetchGitlabAgentAccounts(id as string), {
    // The CP returns from hook CRUD BEFORE the saga creates or retires an account, so one
    // immediate read would race it. Poll until the accounts match the groups, then rest.
    refreshInterval: (latest) => (settled(latest, rootGroups.length) ? 0 : CONVERGENCE_POLL_MS),
    shouldRetryOnError: false
  })

  // Absent, not empty: most agents have no GitLab project, and a deployment without GitLab reports `enabled: false`.
  if (!data?.enabled || data.accounts.length === 0) return null
  const groups = groupByRoot(data.accounts)

  return (
    <div className={`card overflow-hidden ${className}`}>
      <div className="flex min-h-[53px] items-center gap-[10px] border-b border-(--border-subtle) px-4 py-3 desktop:min-h-[55px] desktop:px-[14px] desktop:py-[13px]">
        <span className="flex h-[22px] w-[22px] flex-none items-center justify-center">
          <GitlabMark fillPct={100} />
        </span>
        <span className="min-w-0 flex-1 font-sans text-[14px] font-semibold leading-normal">GitLab identity</span>
      </div>
      <div className="px-4 pt-3 font-sans text-[11.5px] font-normal leading-[1.45] text-(--text-tertiary) desktop:px-[14px]">
        The bot account this agent acts as on GitLab — its notes, reviews, and pushes are authored by it.
      </div>
      {groups.map((group, index) => (
        <div
          key={group.rootGroupId}
          data-gitlab-group={group.rootGroupId}
          className={index > 0 ? 'border-t border-(--border-subtle)' : undefined}
        >
          {/* One group needs no heading; several do — the account is per top-level group. */}
          {groups.length > 1 && (
            <div className="border-b border-(--border-subtle) bg-(--surface-app) px-4 py-[6px] desktop:px-[14px]">
              <span className="mono truncate text-[11.5px] text-(--text-tertiary)">{group.label}</span>
            </div>
          )}
          {group.accounts.map((account) => (
            <AccountChip key={account.id} account={account} />
          ))}
        </div>
      ))}
    </div>
  )
}
