'use client'

// The skills an agent's materialized workspace can actually load, tagged by
// origin. This is the one place accepted Dream skills and repo-committed skills
// surface after they are in the workspace — installs (Git sources, managed
// bundles) also appear here so a single list answers "what can this agent run?".
// Rendered inside the "Loaded from workspace" card on the agent Tools & Skills tab.

import useSWR from 'swr'
import { useOrgs } from '@/lib/org-context'
import { consoleKeys } from '@/lib/swr-keys'
import { fetchAgentLocalSkills, type LocalSkillOrigin } from '@/lib/api'
import { Icon } from '@/components/ui'
import { LoadingState } from '@/components/marks'

const ORIGIN_LABEL: Record<LocalSkillOrigin, string> = {
  'dream-accepted': 'Dream',
  managed: 'Managed',
  'git-source': 'Git source',
  repo: 'Repo'
}

const rowMessage = (text: string) => (
  <div className="px-4 py-[13px] font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary) desktop:py-3">
    {text}
  </div>
)

export function LocalSkillsList({ agentId }: { agentId: string }) {
  const { activeOrg } = useOrgs()
  const { data, error, isLoading } = useSWR(consoleKeys.agentLocalSkills(activeOrg?.id, agentId), () =>
    fetchAgentLocalSkills(agentId)
  )

  if (isLoading) return <LoadingState />
  // A 503 here means the owning daemon is offline / the agent is unplaced.
  if (error) return rowMessage('Could not load workspace skills — the agent’s daemon may be offline.')
  if (!data) return rowMessage('Nothing indexed from the workspace yet.')
  if (!data.materialized)
    return rowMessage('The workspace has not been prepared yet — skills appear after the first run.')
  if (data.skills.length === 0) return rowMessage('No skills loaded from the workspace yet.')

  return (
    <>
      {data.skills.map((skill, index) => (
        <div
          key={skill.path}
          className={`flex items-center gap-[11px] px-4 py-[11px] desktop:py-3 ${
            index > 0 ? 'border-t border-(--border-subtle)' : ''
          }`}
        >
          <Icon name="file-text" size={16} color="var(--text-tertiary)" />
          <span className="mono flex-none text-[12.5px]">{skill.name}</span>
          {skill.description ? (
            <span className="flex-1 truncate font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
              {skill.description}
            </span>
          ) : (
            <span className="flex-1" />
          )}
          <span className="flex-none rounded border border-(--border-subtle) px-[6px] py-[1px] font-sans text-[10.5px] font-normal leading-normal text-(--text-secondary)">
            {ORIGIN_LABEL[skill.origin]}
          </span>
        </div>
      ))}
    </>
  )
}
