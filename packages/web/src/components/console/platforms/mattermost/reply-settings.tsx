import { useState } from 'react'
import { useTranslations } from 'next-intl'
import useSWR from 'swr'
import { apiGet, apiPut, orgBase } from '@/lib/api'
import { MOCK_MODE, type IntegrationRow } from '@/lib/data'
import { useConsoleData } from '@/lib/data-context'
import { useOrgs } from '@/lib/org-context'

interface ReplySettings {
  websocketRepliesOnly: boolean
}

export function MattermostReplySettings({ integration, padX }: { integration: IntegrationRow; padX: number }) {
  const t = useTranslations('Platforms.mattermost.settings')
  const { activeOrg } = useOrgs()
  const { getAgent } = useConsoleData()
  const path =
    !MOCK_MODE && activeOrg && integration.id
      ? `${orgBase(activeOrg.id)}/integrations/${encodeURIComponent(integration.id)}/mattermost/reply-settings`
      : null
  const { data, mutate, isValidating } = useSWR(path, (url: string) => apiGet<ReplySettings>(url))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  if (!data || !path) return null
  const canEdit = !!integration.agentId && getAgent(integration.agentId)?.canEdit
  async function change(enabled: boolean) {
    if (!path || saving) return
    setSaving(true)
    setError('')
    try {
      await mutate(await apiPut<ReplySettings>(path, { websocketRepliesOnly: enabled }), { revalidate: false })
    } catch (err) {
      setError(err instanceof Error ? err.message : t('replySettingsError'))
      await mutate()
    } finally {
      setSaving(false)
    }
  }
  return (
    <div className="py-2 text-sm" style={{ paddingInline: padX }}>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={data.websocketRepliesOnly}
          disabled={!canEdit || saving || isValidating}
          onChange={(event) => void change(event.target.checked)}
        />
        {t('websocketRepliesOnly')}
      </label>
      <p className="psub">{t('websocketRepliesHint')}</p>
      {error && (
        <p role="alert" className="text-(--status-error)">
          {error}
        </p>
      )}
    </div>
  )
}
