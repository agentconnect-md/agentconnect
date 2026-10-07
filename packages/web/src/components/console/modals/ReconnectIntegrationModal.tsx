import { useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { AgentPicker } from '../AgentPicker'
import { platformRegistry } from '../platforms/registry'
import { PlatformMark } from '@/components/marks'
import { Button, Icon } from '@/components/ui'
import { agentCapabilitySource, agentLabel } from '@/lib/data'
import { useConsoleData } from '@/lib/data-context'
import { useOrgs } from '@/lib/org-context'

export default function ReconnectIntegrationModal({ botId, onClose }: { botId: string; onClose: () => void }) {
  const t = useTranslations('Integrations.dialog')
  const { activeOrg } = useOrgs()
  const { agents, bots, daemons, memberSets, createIntegration } = useConsoleData()
  const [agentId, setAgentId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const busy = useRef(false)
  const bot = bots.find((item) => item.id === botId)
  const wizard = bot ? platformRegistry.get(bot.platform)?.wizard : undefined
  const available = !!bot && !!wizard && !bot.revokedAt && !bot.inUseByAgentId && bot.agentIds.length === 0
  const choices = agents.filter((agent) => {
    if (!available || !agent.canEdit) return false
    const source = agentCapabilitySource(agent, daemons, memberSets)
    return (
      (!source || source.caps.platforms.includes(bot.platform)) &&
      wizard.freeBotFilter(bot, { agentId: agent.id, region: bot.feishuRegion ?? undefined, shared: bot.shareable })
    )
  })
  const builtin = bot?.prebuilt ? choices.find((agent) => agent.builtin) : undefined
  const agent = builtin ?? choices.find((item) => item.id === agentId)

  async function reconnect() {
    if (busy.current || !available || !agent) return
    busy.current = true
    setSaving(true)
    setError(null)
    try {
      await createIntegration(
        wizard.buildReuseInput(bot, { agentId: agent.id, region: bot.feishuRegion ?? undefined, shared: bot.shareable })
      )
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      busy.current = false
      setSaving(false)
    }
  }

  return (
    <>
      <div className="modalhead">
        <div className="min-w-0 flex-1 font-sans text-[16px] font-semibold leading-normal">
          {t('reconnectIntegration')}
        </div>
        <button className="iconbtn" aria-label={t('close')} disabled={saving} onClick={onClose}>
          <Icon name="x" size={16} />
        </button>
      </div>
      <div className="modalbody">
        {bot && (
          <div className="mb-5 flex items-center gap-3 rounded-md border border-(--border-subtle) p-3">
            <span className="imark h-8 w-8 flex-none">
              <PlatformMark platform={bot.platform} />
            </span>
            <div className="min-w-0">
              <div className="font-sans text-[14px] font-semibold leading-normal">{bot.name}</div>
              {bot.workspaceName && <div className="text-[12px] text-(--text-secondary)">{bot.workspaceName}</div>}
            </div>
          </div>
        )}
        <div className="fldlbl mb-2">{t('organization')}</div>
        <div className="mb-5 text-[14px] text-(--text-primary)">{activeOrg?.name || activeOrg?.slug}</div>
        {available && choices.length > 0 ? (
          <>
            <div className="fldlbl mb-2">{t('agent')}</div>
            {builtin ? (
              <div className="text-[14px] text-(--text-primary)">{agentLabel(builtin)}</div>
            ) : (
              <AgentPicker agents={choices} value={agent?.id ?? null} onPick={setAgentId} disabled={saving} />
            )}
          </>
        ) : (
          <p className="text-[13px] text-(--text-secondary)">
            {t(available ? 'noReconnectAgents' : 'reconnectUnavailable')}
          </p>
        )}
        {error && (
          <p role="alert" className="mt-4 text-[13px] text-(--status-error)">
            {error}
          </p>
        )}
      </div>
      <div className="modalfoot">
        <Button variant="secondary" disabled={saving} onClick={onClose}>
          {t('cancel')}
        </Button>
        <Button variant="primary" disabled={saving || !agent} onClick={() => void reconnect()}>
          {t(saving ? 'reconnecting' : 'reconnect')}
        </Button>
      </div>
    </>
  )
}
