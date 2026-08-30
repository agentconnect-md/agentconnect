import type { SlackBotRefreshDto } from '@/lib/api'

export interface SlackRefreshNoticeState {
  needsAttention: boolean
  message: string
  action: {
    href: string
    label: 'Open App Manifest' | 'Update permissions' | 'Reinstall workspace' | 'Open Slack'
  } | null
}

/**
 * Collapse refresh results into one primary action. `manual_update_required`
 * means automatic manifest sync was unavailable, not that drift was observed;
 * when the installed token already has every required scope, avoid turning that
 * uncertainty into a persistent warning. Explicit manifest failures remain
 * actionable, and authorization failures always take priority over manifest UI.
 */
export function slackRefreshNoticeState(result: SlackBotRefreshDto): SlackRefreshNoticeState {
  // An install missing only capability scopes is HEALTHY, so it is not "attention" — the tools
  // those scopes back simply stay off until someone reinstalls, and saying nothing was the bug.
  const capabilityGap = (result.missingCapabilityScopes ?? []).length > 0
  const needsAttention = result.authorization !== 'current' || result.manifest === 'unknown'
  let action: SlackRefreshNoticeState['action'] = null

  if (result.authorization === 'invalid') {
    action = { href: result.reinstallUrl, label: 'Reinstall workspace' }
  } else if (result.authorization === 'app_mismatch') {
    action = { href: result.settingsUrl, label: 'Open Slack' }
  } else if (result.authorization === 'reinstall_required') {
    action = {
      href: result.manifest === 'synced' ? result.reinstallUrl : result.permissionsUrl,
      label: result.manifest === 'synced' ? 'Reinstall workspace' : 'Update permissions'
    }
  } else if (result.authorization === 'current' && capabilityGap) {
    // The install works; a reinstall is what turns the optional tools on.
    action = {
      href: result.manifest === 'synced' ? result.reinstallUrl : result.permissionsUrl,
      label: result.manifest === 'synced' ? 'Reinstall workspace' : 'Update permissions'
    }
  } else if (result.authorization === 'current' && result.manifest === 'unknown') {
    action = { href: result.manifestUrl, label: 'Open App Manifest' }
  } else if (result.authorization === 'unknown') {
    action =
      result.manifest === 'synced'
        ? { href: result.settingsUrl, label: 'Open Slack' }
        : { href: result.manifestUrl, label: 'Open App Manifest' }
  }

  let message = 'Slack app configuration and workspace permissions are up to date.'
  if (result.authorization === 'invalid') {
    message =
      'Slack rejected the stored bot token. Reinstall the app if needed, then recreate this integration with the current Bot User OAuth Token.'
  } else if (result.authorization === 'app_mismatch') {
    message = 'The stored bot token belongs to a different Slack app. Recreate this integration with matching tokens.'
  } else if (result.authorization === 'reinstall_required' && capabilityGap) {
    // Both halves missing — the common case for an install predating a release. Ahead of the
    // plain reinstall branches so it actually wins, and worded so the required scopes do not
    // read as the whole list: the scope line beside this message now carries the union.
    message =
      result.manifest === 'synced'
        ? 'Slack app configuration is synced. Reinstall it to grant every missing scope, required and optional.'
        : 'Add every missing scope below in Slack’s OAuth & Permissions page, then reinstall the app.'
  } else if (result.authorization === 'reinstall_required' && result.manifest === 'synced') {
    message = 'Slack app configuration is synced. Reinstall it to grant the missing scopes.'
  } else if (result.authorization === 'reinstall_required') {
    message = 'Add the missing scopes in Slack’s OAuth & Permissions page, then reinstall the app.'
  } else if (result.authorization === 'current' && capabilityGap) {
    // Ahead of the manifest branches on purpose: an install short of capability scopes used to
    // be told its permissions "match AgentConnect's requirements", which is the reassurance
    // this case exists to withdraw. What the operator does next depends on the manifest —
    // a synced app only needs reinstalling, an unsynced one needs the scopes added first.
    const n = (result.missingCapabilityScopes ?? []).length
    const count = `${n} optional permission${n === 1 ? ' is' : 's are'} not`
    message =
      result.manifest === 'synced'
        ? `Everything required is granted; ${count}. Reinstall to enable the agent tools that need them.`
        : `Everything required is granted; ${count}. Add them in Slack’s OAuth & Permissions page, then reinstall.`
  } else if (result.authorization === 'current' && result.manifest === 'manual_update_required') {
    message = 'Workspace permissions match AgentConnect’s requirements.'
  } else if (result.manifest === 'manual_update_required') {
    message = 'Automatic manifest refresh is unavailable. Review and update this app in Slack.'
  } else if (result.manifest === 'unknown') {
    message = 'The Slack app manifest could not be confirmed. Review it in Slack or try again.'
  } else if (result.authorization === 'unknown') {
    message = 'Slack app configuration is synced, but workspace permissions could not be confirmed.'
  }

  return { needsAttention, message, action }
}
