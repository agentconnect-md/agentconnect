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

export function AgentGitlabIdentity({ agentId, className = '' }: { agentId: string; className?: string }) {
  const { activeOrg } = useOrgs()
  const accountsKey = MOCK_MODE ? null : consoleKeys.agentGitlabAccounts(activeOrg?.id, agentId)
  const { data } = useSWR(accountsKey, ([, , , id]) => fetchGitlabAgentAccounts(id as string), {
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
