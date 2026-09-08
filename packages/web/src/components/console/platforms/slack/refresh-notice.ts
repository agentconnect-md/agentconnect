import type { SlackBotRefreshDto } from '@/lib/api'

export interface SlackRefreshNoticeState {
  needsAttention: boolean
  message: string
  action: {
    href: string
    label: 'Open App Manifest' | 'Reinstall workspace' | 'Open Slack'
  } | null
  /** The missing scopes as a paste-ready manifest block, or null when no hand edit is the remedy. */
  scopeFragment: string | null
}

/** JSON array items, one per line with a trailing comma, so the block pastes verbatim right after `"bot": [` in the manifest. */
export function slackManifestScopeFragment(scopes: readonly string[]): string {
  return scopes.map((scope) => `${JSON.stringify(scope)},`).join('\n')
}

/**
 * Collapse refresh results into one primary action. `manual_update_required`
 * means automatic manifest sync was unavailable, not that drift was observed;
 * when the installed token already has every required scope, avoid turning that
 * uncertainty into a persistent warning. Explicit manifest failures remain
 * actionable, and authorization failures always take priority over manifest UI.
 */
export function slackRefreshNoticeState(result: SlackBotRefreshDto): SlackRefreshNoticeState {
  const needsAttention = result.authorization !== 'current' || result.manifest === 'unknown'
  // A short grant we could not sync is fixed in Slack's MANIFEST editor: the OAuth picker hides scopes by plan, the manifest takes them all.
  const manualScopes = result.authorization === 'reinstall_required' && result.manifest !== 'synced'
  let action: SlackRefreshNoticeState['action'] = null

  if (result.authorization === 'invalid') {
    action = { href: result.reinstallUrl, label: 'Reinstall workspace' }
  } else if (result.authorization === 'app_mismatch') {
    action = { href: result.settingsUrl, label: 'Open Slack' }
  } else if (result.authorization === 'reinstall_required') {
    action = manualScopes
      ? { href: result.manifestUrl, label: 'Open App Manifest' }
      : { href: result.reinstallUrl, label: 'Reinstall workspace' }
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
    // Slack's own code is the diagnosis: `invalid_auth` also answers a caller its IP allowlist excludes.
    message = `Slack rejected the stored bot token (${result.rejection ?? 'invalid'}). Reinstall the app if needed, then recreate this integration with the current Bot User OAuth Token.`
  } else if (result.authorization === 'app_mismatch') {
    message = 'The stored bot token belongs to a different Slack app. Recreate this integration with matching tokens.'
  } else if (result.authorization === 'reinstall_required' && !manualScopes) {
    message = 'Slack app configuration is synced. Reinstall it to grant the missing scopes.'
  } else if (result.authorization === 'reinstall_required') {
    message =
      'Add the missing scopes to the app manifest in Slack — copy them and paste the list at the top of oauth_config.scopes.bot — then reinstall the app.'
  } else if (result.authorization === 'current' && result.manifest === 'manual_update_required') {
    message = 'Workspace permissions match AgentConnect’s requirements.'
  } else if (result.manifest === 'manual_update_required') {
    message = 'Automatic manifest refresh is unavailable. Review and update this app in Slack.'
  } else if (result.manifest === 'unknown') {
    message = 'The Slack app manifest could not be confirmed. Review it in Slack or try again.'
  } else if (result.authorization === 'unknown') {
    message = 'Slack app configuration is synced, but workspace permissions could not be confirmed.'
  }

  return {
    needsAttention,
    message,
    action,
    scopeFragment:
      manualScopes && result.missingScopes.length > 0 ? slackManifestScopeFragment(result.missingScopes) : null
  }
}
