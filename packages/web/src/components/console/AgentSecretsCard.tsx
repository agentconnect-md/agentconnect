'use client'

import { MOCK_PREFIX, type Agent } from '@/lib/data'
import { useModal } from '@/components/console/ModalProvider'
import { Button, Icon } from '@/components/ui'

/**
 * The config tab's read-only "Secrets" card — write-only secret env vars. Values
 * are never returned by the API, so each name is shown masked. Editing is unified
 * with every other config group: the header Edit opens the Edit-agent modal's
 * "Secrets and variables" section. Sibling of the Variables card.
 */
export function AgentSecretsCard({ agent }: { agent: Agent }) {
  const { openModal } = useModal()
  const editable = !agent.name.startsWith(MOCK_PREFIX)
  const total = agent.secretKeys.length

  return (
    <div className="card">
      <div className="cardhead justify-between">
        <span className="inline-flex min-w-0 items-baseline gap-[7px]">
          <span className="cardtitle">Secrets</span>
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
        {agent.secretKeys.map((k, i) => (
          <div key={i} className="row grid-cols-[minmax(0,1fr)_auto] gap-3 px-4 py-[10px]">
            <span className="flex min-w-0 items-center gap-[7px]">
              <Icon name="lock" size={11} color="var(--text-tertiary)" className="flex-none" />
              <span className="mono min-w-0 truncate text-[12px] text-(--text-primary)" title={k}>
                {k}
              </span>
            </span>
            <span className="mono text-[12px] text-(--text-tertiary)" title="Write-only — value can’t be viewed">
              ••••••••
            </span>
          </div>
        ))}
        {total === 0 && (
          <div className="px-4 py-[11px] font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
            No secrets
          </div>
        )}
      </div>
    </div>
  )
}
