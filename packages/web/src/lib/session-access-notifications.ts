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

/** Where an installed app's permissions are actually repaired: the app's own row
 *  on Integrations, whose refresh action asks Slack which scopes the
 *  installation granted and names the missing ones. */
const SLACK_APP_SETTINGS_PATH = '/integrations?platform=slack'

/**
 * A degradation an administrator can clear, as opposed to one that clears
 * itself.
 *
 * Exported because two surfaces answer this question — the notification below
 * and the conversation page that refuses to render — and they must not drift on
 * it. Getting it wrong in either direction is a real cost: calling a permanent
 * state transient tells someone to wait for something that will never happen,
 * and calling a transient one permanent sends them to reauthorize a healthy app.
 */
export function isAppAuthorizationIssue(issue: SessionAccessIssue): boolean {
  return issue.provider === 'slack' && issue.reason === 'app_authorization'
}

/**
 * What a conversation page that could not be verified should say, and what it
 * should offer instead of guessing.
 *
 * The page fails closed on purpose — refusing to report "not found" for
 * something the console never got a verdict on is right and stays. What was
 * wrong is the assumption underneath it, that every such state is transient. A
 * short app grant never clears, so the retry it offered could not succeed;
 * worse, a successful resolution is cached (the plugin's allow lease plus the
 * access snapshot), so the page keeps working for a couple of minutes at a time
 * and the permanent failure is experienced as flakiness. Hence `retry` is a
 * property of the CAUSE here, not a constant.
 */
export interface UnverifiedConversationNotice {
  message: string
  /** Whether trying the same read again could plausibly answer differently. */
  retry: boolean
  action?: SessionAccessNotificationAction
}

const BOT_PLATFORM_NAMES: Record<string, string> = {
  telegram: 'Telegram',
  discord: 'Discord',
  gitlab: 'GitLab',
  googlechat: 'Google',
  msteams: 'Microsoft'
}
// The sign-in method a platform's people link, where its name differs from the platform's.
const PROFILE_PROVIDERS: Record<string, string> = { googlechat: 'google', msteams: 'azuread' }
const APP_ACCESS_MESSAGES: Record<string, string> = {
  telegram:
    'The Telegram chat bot must be an administrator to verify group membership. Ask a group administrator to check its role and credentials.',
  discord:
    'The Discord bot cannot verify conversation access. Ask a server administrator to check its channel access and credentials.',
  googlechat:
    'The Google Chat app cannot verify space membership. Ask an administrator to check the app’s space access and credentials.',
  msteams:
    'The Teams bot cannot verify conversation membership. Ask an administrator to check that the app is still installed and its client secret is current.',
  gitlab:
    'The GitLab connection cannot verify project access. Ask an organization owner to reconnect it in Integrations.'
}

function botAccessNotice(
  issue: SessionAccessIssue,
  orgPath: (path: string) => string
): UnverifiedConversationNotice | undefined {
  const name = BOT_PLATFORM_NAMES[issue.provider]
  if (!name) return undefined
  if (issue.reason === 'authorization')
    return {
      message: `Link your ${name} account in Profile to check access to these conversations.`,
      retry: false,
      action: {
        label: `Link ${name}`,
        href: orgPath(`/profile?reauthorize=${PROFILE_PROVIDERS[issue.provider] ?? issue.provider}#sign-in-methods`),
        external: false
      }
    }
  if (issue.reason === 'app_authorization')
    return {
      message: APP_ACCESS_MESSAGES[issue.provider]!,
      retry: false,
      action: { label: 'Open Integrations', href: orgPath(`/integrations?platform=${issue.provider}`), external: false }
    }
  return undefined
}

export function unverifiedConversationNotice(
  failed: boolean,
  issues: readonly SessionAccessIssue[],
  orgPath: (path: string) => string
): UnverifiedConversationNotice {
  // A failed request is not an access verdict at all — the console never
  // reached the control plane, and that genuinely is worth retrying.
  if (failed) {
    return {
      message: 'This conversation could not be loaded. The console could not reach the control plane.',
      retry: true
    }
  }
  const botNotice = issues.map((issue) => botAccessNotice(issue, orgPath)).find((notice) => notice !== undefined)
  if (botNotice) return botNotice
  if (issues.some(isAppAuthorizationIssue)) {
    return {
      message:
        'This conversation is hidden because a Slack app is missing permissions AgentConnect needs. It will not clear on its own — refresh the app in Integrations to restore access.',
      retry: false,
      action: { label: 'Open Integrations', href: orgPath(SLACK_APP_SETTINGS_PATH), external: false }
    }
  }
  return { message: 'This conversation cannot be shown until its access checks can be verified.', retry: true }
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

/**
 * The installed app's grant fell short — an administrator's two-minute fix, not
 * an outage.
 *
 * It routes to the app's own row on Integrations rather than restating what is
 * wrong, because the row's refresh action is the AUTHORITATIVE per-app
 * diagnosis: it asks Slack which scopes the installation actually granted and
 * names the missing ones. This notification only knows that some app behind the
 * sessions on this page came up short, so telling the reader more than "one of
 * your Slack apps needs reauthorizing, here is where you fix it" would be
 * guessing — see the plugin's `accessIssueFor`.
 */
function appAuthorizationNotification(
  surface: SessionAccessSurface,
  orgPath: (path: string) => string
): SessionAccessNotificationInput {
  return {
    category: 'session_access',
    severity: 'warning',
    sourceKey: `${surface}:slack:app_authorization`,
    title: 'Reauthorize your Slack app',
    message:
      surface === 'sessions'
        ? 'Refresh the app in Integrations to grant the permissions AgentConnect needs and restore access to affected sessions.'
        : 'Refresh the app in Integrations to grant the permissions AgentConnect needs and restore usage from affected sessions.',
    action: {
      label: 'Open Integrations',
      href: orgPath(SLACK_APP_SETTINGS_PATH),
      external: false
    }
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
    const notice = botAccessNotice(issue, orgPath)
    if (notice) {
      const sourceKey = `${surface}:${issue.provider}:${issue.reason}`
      notifications.set(sourceKey, {
        category: 'session_access',
        severity: 'warning',
        sourceKey,
        title: `${BOT_PLATFORM_NAMES[issue.provider]} access needs attention`,
        message: notice.message,
        action: notice.action
      })
      continue
    }
    if (
      issue.provider === 'feishu' &&
      (issue.region === 'feishu' || issue.region === 'lark') &&
      (issue.reason === 'quota' || issue.reason === 'authorization')
    ) {
      const notification = classifiedNotification(surface, issue.region, issue.reason, orgPath)
      notifications.set(notification.sourceKey, notification)
    } else if (isAppAuthorizationIssue(issue)) {
      const notification = appAuthorizationNotification(surface, orgPath)
      notifications.set(notification.sourceKey, notification)
    } else {
      // Including a Slack `unavailable`: rate limiting and outages really do
      // clear on their own, and relabelling them would put a "reauthorize your
      // app" prompt in front of someone with nothing to reauthorize.
      needsGeneric = true
    }
  }

  if (needsGeneric) {
    const notification = genericNotification(surface)
    notifications.set(notification.sourceKey, notification)
  }

  return [...notifications.values()].sort((a, b) => a.sourceKey.localeCompare(b.sourceKey))
}
