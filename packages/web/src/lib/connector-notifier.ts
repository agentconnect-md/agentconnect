'use client'

import { useEffect } from 'react'
import { useTranslations } from 'next-intl'
import type { McpProviderDto } from '@/lib/api'
import { useNotifications, type NotificationSnapshotInput } from '@/lib/notifications'

type ConnectionCopy = (
  key: 'title' | 'message' | 'action' | 'resolvedTitle' | 'resolvedMessage',
  values?: { name: string }
) => string

export function connectorCredentialNotifications(
  providers: readonly McpProviderDto[],
  orgPath: (path: string) => string,
  t: ConnectionCopy
): NotificationSnapshotInput[] | null {
  const editable = providers.filter((p) => p.kind === 'open_connector' && p.canEdit)
  // An unavailable status source is not evidence that an existing warning has been resolved.
  if (editable.some((p) => p.connectorStatus === 'unknown' || p.connectorStatus === undefined)) return null
  return editable
    .filter((p) => p.connectorStatus === 'reauth_required')
    .map((p) => ({
      category: 'integration',
      severity: 'error',
      sourceKey: `connector-reauth:${p.id}`,
      title: t('title'),
      message: t('message', { name: p.name }),
      action: { label: t('action'), href: orgPath('/tools'), external: false },
      resolution: {
        title: t('resolvedTitle'),
        message: t('resolvedMessage', { name: p.name }),
        severity: 'info',
        read: true
      }
    }))
}

export function useConnectorNotifier(
  providers: readonly McpProviderDto[],
  loaded: boolean,
  orgPath: (path: string) => string
): void {
  const t = useTranslations('Tools.mcp.connectionNotification')
  const { syncSourceSnapshot } = useNotifications()
  useEffect(() => {
    if (!loaded) return
    const items = connectorCredentialNotifications(providers, orgPath, t)
    if (items) syncSourceSnapshot('connectors', items)
  }, [providers, loaded, orgPath, t, syncSourceSnapshot])
}
