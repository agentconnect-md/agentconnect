'use client'

// The agent's repository selector: the Decision provider and model that choose which By decision repositories a session checks out.

import type { Ref } from 'react'
import { useTranslations } from 'next-intl'
import type { AgentRepositorySelector } from '@agentconnect.md/protocol/decision'
import type { DecisionProviderOption } from '@agentconnect.md/protocol/decision-api'
import { DecisionModelSelect } from '@/components/console/decisions/DecisionModelSelect'
import { Icon } from '@/components/ui'

export function RepositorySelectorField({
  ref,
  value,
  providers,
  disabled,
  onChange
}: {
  ref?: Ref<HTMLDivElement>
  value: AgentRepositorySelector | null
  providers: readonly DecisionProviderOption[]
  disabled: boolean
  onChange: (value: AgentRepositorySelector | null) => void
}) {
  const t = useTranslations('Agents.workspaceEdit')
  return (
    <div ref={ref} className="fld mt-3" data-repository-selector>
      <span className="fldlbl" title={t('repositorySelectorTitle')}>
        {t('repositorySelector')}
      </span>
      <div className="flex min-w-0 items-center gap-2">
        <div className="min-w-0 flex-1">
          <DecisionModelSelect
            providerId={value?.providerId ?? ''}
            model={value?.model ?? ''}
            questionType="choice"
            providers={[...providers]}
            disabled={disabled}
            placeholder={t('repositorySelectorPlaceholder')}
            ariaLabel={t('repositorySelector')}
            onChange={onChange}
          />
        </div>
        {value && (
          <button
            type="button"
            className="iconbtn h-9 w-9 flex-none"
            title={t('clearRepositorySelector')}
            aria-label={t('clearRepositorySelector')}
            disabled={disabled}
            onClick={() => onChange(null)}
          >
            <Icon name="x" size={14} />
          </button>
        )}
      </div>
    </div>
  )
}
