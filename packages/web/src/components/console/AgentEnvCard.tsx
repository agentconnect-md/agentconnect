'use client'

import { useState } from 'react'
import { MOCK_PREFIX, type Agent } from '@/lib/data'
import { useModal } from '@/components/console/ModalProvider'
import { Button, Icon } from '@/components/ui'

// Collapse the list past this many rows behind a "Show all" toggle.
const COLLAPSE_AT = 6

/**
 * The config tab's read-only "Variables" card. Env values are plain configuration
 * injected into the runtime by the daemon. Editing is unified with every other
 * config group: the header Edit opens the Edit-agent modal's "Secrets and
 * variables" section. Long lists collapse behind "Show all". Sibling of the
 * Secrets card.
 */
export function AgentEnvCard({ agent }: { agent: Agent }) {
  const { openModal } = useModal()
  const editable = !agent.name.startsWith(MOCK_PREFIX)
  const [showAll, setShowAll] = useState(false)
  const total = agent.env.length
  const collapsed = !showAll && total > COLLAPSE_AT
  const visible = collapsed ? agent.env.slice(0, COLLAPSE_AT) : agent.env

  return (
    <div className="card">
      <div className="cardhead justify-between">
        <span className="inline-flex min-w-0 items-baseline gap-[7px]">
          <span className="cardtitle">Variables</span>
          {total > 0 && <span className="mono text-[11px] text-(--text-tertiary)">{total}</span>}
        </span>
        {editable && (
          <Button
            variant="secondary"
            size="xs"
            onClick={() => openModal('editAgent', agent, { focusSection: 'secrets' })}
          >
            <Icon name="pencil" size={14} />
            Edit
          </Button>
        )}
      </div>
      <div className="py-1">
        {visible.map((e, i) => (
          <div key={i} className="row grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] gap-3 px-4 py-[10px]">
            <span className="mono min-w-0 truncate text-[12px] text-(--text-primary)" title={e.k}>
              {e.k}
            </span>
            <span className="mono min-w-0 truncate text-right text-[12px] text-(--text-tertiary)" title={e.v}>
              {e.v}
            </span>
          </div>
        ))}
        {total === 0 && (
          <div className="px-4 py-[11px] font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
            No variables
          </div>
        )}
        {collapsed && (
          <button className="lnk w-full px-4 py-[9px] text-left text-[12px]" onClick={() => setShowAll(true)}>
            Show all {total}
            <Icon name="chevron-down" size={13} />
          </button>
        )}
        {showAll && total > COLLAPSE_AT && (
          <button className="lnk w-full px-4 py-[9px] text-left text-[12px]" onClick={() => setShowAll(false)}>
            Show less
            <Icon name="chevron-up" size={13} />
          </button>
        )}
      </div>
    </div>
  )
}
