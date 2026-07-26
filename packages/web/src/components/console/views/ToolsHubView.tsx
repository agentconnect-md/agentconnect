'use client'

import useSWR from 'swr'
import { MOCK_MODE } from '@/lib/data'
import { useConsoleData } from '@/lib/data-context'
import { useOrgs } from '@/lib/org-context'
import { fetchExternalMemoryConnections } from '@/lib/api'
import { consoleKeys } from '@/lib/swr-keys'
import { McpServersCard } from '@/components/console/McpServersCard'
import { SkillSourcesCard } from '@/components/console/SkillSourcesCard'
import { MemoryConnectionsCard } from '@/components/console/MemoryConnectionsCard'

export default function ToolsHubView() {
  const { mcpProviders, skillSources } = useConsoleData()
  const { activeOrg, myRole } = useOrgs()
  const memoryConnectionKey = consoleKeys.externalMemoryConnections(activeOrg?.id)
  const { data: memoryConnections = [] } = useSWR(memoryConnectionKey, ([, orgId]) =>
    fetchExternalMemoryConnections(orgId)
  )
  const canWrite = myRole !== 'viewer' // the CP denies viewer writes; hide the controls too
  const canManageMemory = myRole === 'owner' // installation + connection trust actions are owner-only
  // One responsive tree serves both form factors (the phone gets the same content,
  // reflowed): the MCP tiles and Skills library stack to a single column, while
  // `.psub` is hidden on mobile so the Shell app bar's title stands alone.

  return (
    <div className="wrap max-desktop:p-4">
      <div className="mb-4 flex min-h-[34px] items-center gap-4">
        <div className="flex-1">
          <p className="psub mt-0">
            Shared across every agent in your organization — MCP tools they can call and skills they can run.
          </p>
        </div>
      </div>
      <div
        className={
          MOCK_MODE
            ? 'mb-[18px] grid grid-cols-2 gap-[14px] desktop:grid-cols-4'
            : 'mb-[18px] grid grid-cols-2 gap-[14px] desktop:grid-cols-3'
        }
      >
        <div className="card stat">
          <div className="statlbl">MCP servers</div>
          <div className="statval">{mcpProviders.length}</div>
        </div>
        <div className="card stat">
          <div className="statlbl">Skill sources</div>
          <div className="statval">{skillSources.length}</div>
        </div>
        <div className="card stat">
          <div className="statlbl">External memory</div>
          <div className="statval">{memoryConnections.length}</div>
        </div>
        {/* Tool-call metering has no backend yet — the design's demo stat renders
            only in mock mode with its demo value. */}
        {MOCK_MODE && (
          <div className="card stat">
            <div className="statlbl">Tool calls · 24h</div>
            <div className="statval">4,812</div>
          </div>
        )}
      </div>
      <McpServersCard canWrite={canWrite} />
      <SkillSourcesCard canWrite={canWrite} />
      <MemoryConnectionsCard canManage={canManageMemory} />
    </div>
  )
}
