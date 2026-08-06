import type { SessionAccessIssue } from '@/lib/api'

export type SessionAccessSurface = 'sessions' | 'usage'

export interface SessionAccessNotificationAction {
  label: string
  href: string
  external: boolean
}

export interface SessionAccessNotificationInput {
  category: 'session_access'
  severity: 'warning'
  sourceKey: string
  title: string
  message: string
  action?: SessionAccessNotificationAction
}

const FEISHU_ADMIN_URL = {
  feishu: 'https://www.feishu.cn/admin',
  lark: 'https://www.larksuite.com/admin'
} as const

type FeishuRegion = keyof typeof FEISHU_ADMIN_URL

function regionName(region: FeishuRegion): 'Feishu' | 'Lark' {
  return region === 'feishu' ? 'Feishu' : 'Lark'
}

function genericNotification(surface: SessionAccessSurface): SessionAccessNotificationInput {
  return {
    category: 'session_access',
    severity: 'warning',
    sourceKey: `${surface}:generic:unavailable`,
    title: surface === 'sessions' ? 'Session access checks unavailable' : 'Usage access checks unavailable',
    message:
      surface === 'sessions'
        ? 'Affected sessions are hidden until access can be verified.'
        : 'Usage is temporarily under-counted rather than exposing inaccessible sessions.'
  }
}

function classifiedNotification(
  surface: SessionAccessSurface,
  region: FeishuRegion,
  reason: 'authorization' | 'quota',
  orgPath: (path: string) => string
): SessionAccessNotificationInput {
  const name = regionName(region)
  if (reason === 'quota') {
    return {
      category: 'session_access',
      severity: 'warning',
      sourceKey: `${surface}:feishu:${region}:quota`,
      title: `${name} API quota exhausted`,
      message:
        surface === 'sessions'
          ? 'Affected sessions are hidden until an administrator increases the allowance or the monthly quota resets.'
          : 'Usage from affected sessions is temporarily under-counted until an administrator increases the allowance or the monthly quota resets.',
      action: {
        label: `Open ${name} Admin`,
        href: FEISHU_ADMIN_URL[region],
        external: true
      }
    }
  }

  return {
    category: 'session_access',
    severity: 'warning',
    sourceKey: `${surface}:feishu:${region}:authorization`,
    title: `Refresh your ${name} sign-in`,
    message:
      surface === 'sessions'
        ? 'Refresh this identity in Profile to restore access to affected sessions.'
        : 'Refresh this identity in Profile to restore usage from affected sessions.',
    action: {
      label: `Refresh ${name}`,
      href: orgPath(`/profile?reauthorize=${region}#sign-in-methods`),
      external: false
    }
  }
}

export function sessionAccessNotifications(
  surface: SessionAccessSurface,
  degraded: boolean,
  issues: readonly SessionAccessIssue[],
  orgPath: (path: string) => string
): SessionAccessNotificationInput[] {
  if (!degraded) return []

  const notifications = new Map<string, SessionAccessNotificationInput>()
  let needsGeneric = issues.length === 0

  for (const issue of issues) {
    if (
      issue.provider === 'feishu' &&
      (issue.region === 'feishu' || issue.region === 'lark') &&
      (issue.reason === 'quota' || issue.reason === 'authorization')
    ) {
      const notification = classifiedNotification(surface, issue.region, issue.reason, orgPath)
      notifications.set(notification.sourceKey, notification)
    } else {
      needsGeneric = true
    }
  }

  if (needsGeneric) {
    const notification = genericNotification(surface)
    notifications.set(notification.sourceKey, notification)
  }

  return [...notifications.values()].sort((a, b) => a.sourceKey.localeCompare(b.sourceKey))
}
