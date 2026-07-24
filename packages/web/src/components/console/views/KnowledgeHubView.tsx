'use client'

import useSWR from 'swr'
import { MOCK_MODE, SKILLS } from '@/lib/data'
import { useConsoleData } from '@/lib/data-context'
import { useModal } from '@/components/console/ModalProvider'
import { useOrgs } from '@/lib/org-context'
import { fetchExternalMemoryConnections } from '@/lib/api'
import { consoleKeys } from '@/lib/swr-keys'
import { McpServersCard } from '@/components/console/McpServersCard'
import { MemoryConnectionsCard } from '@/components/console/MemoryConnectionsCard'
import { Button, Icon } from '@/components/ui'

export default function KnowledgeHubView() {
  const { openModal } = useModal()
  const { mcpProviders } = useConsoleData()
  const { activeOrg, myRole } = useOrgs()
  const memoryConnectionKey = consoleKeys.externalMemoryConnections(activeOrg?.id)
  const { data: memoryConnections = [] } = useSWR(memoryConnectionKey, ([, orgId]) =>
    fetchExternalMemoryConnections(orgId)
  )
  const canWrite = myRole !== 'viewer' // the CP denies viewer writes; hide the controls too
  const canManageMemory = myRole === 'owner' // installation + connection trust actions are owner-only
  // Skills have no CP backend yet — show the design's demo rows only in mock mode,
  // otherwise an empty library. One responsive tree serves both form factors (the
  // phone gets the same content, reflowed): the MCP tiles and Skills library stack
  // to a single column, while `.psub` is hidden on mobile so the Shell app bar's
  // title stands alone.
  const skills = MOCK_MODE ? SKILLS : []

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
          <div className="statlbl">Skills</div>
          <div className="statval">{skills.length}</div>
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
      <div className="card">
        <div className="cardhead justify-between">
          <span className="inline-flex items-baseline gap-[10px]">
            <span className="cardtitle">Skills library</span>
            <span className="mono text-[11px] text-(--text-tertiary)">available to every agent</span>
          </span>
          <Button variant="secondary" size="xs" onClick={() => openModal('skill')}>
            <Icon name="plus" size={14} />
            Add skill
          </Button>
        </div>
        <div className="grid grid-cols-1 gap-3 px-4 py-[14px] desktop:grid-cols-[repeat(2,1fr)]">
          {skills.length === 0 && (
            <div className="font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
              No skills yet.
            </div>
          )}
          {skills.map((k) => (
            <div
              key={k.name}
              className="flex gap-[11px] rounded-[9px] border border-(--border-subtle) px-[14px] py-[13px]"
            >
              <span className="flex h-8 w-8 flex-none items-center justify-center rounded-md bg-(--brand-soft)">
                <Icon name={k.icon} size={17} color="var(--brand)" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="mono text-[12.5px] font-semibold text-(--text-primary)">{k.name}</span>
                  {k.extracted && (
                    <span className="badge bg-(--status-info-soft) text-[9.5px] text-(--status-info)">extracted</span>
                  )}
                </div>
                <div className="mt-[3px] font-sans text-[12px] font-normal leading-[1.45] text-(--text-tertiary)">
                  {k.desc}
                </div>
                <div className="mt-[6px] font-mono text-[11px] font-normal leading-normal text-(--text-disabled)">
                  used by {k.agents} agents
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
      <MemoryConnectionsCard canManage={canManageMemory} />
    </div>
  )
}
