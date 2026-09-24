import { createContext, useContext } from 'react'
import { useTranslations } from 'next-intl'

// The agent whose page is rendering, so agent pickers below it can tag that agent; unset on org pages.
export const SelfAgentContext = createContext<string | undefined>(undefined)

export function useSelfAgentId(): string | undefined {
  return useContext(SelfAgentContext)
}

// Same badge as BuiltinBadge so every agent list marks "this agent" one way.
export function SelfAgentTag() {
  const t = useTranslations('Common.selfAgentTag')
  return <span className="badge flex-none bg-(--surface-active) text-(--text-tertiary)">{t('label')}</span>
}
