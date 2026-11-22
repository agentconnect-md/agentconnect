import type { IconStore } from '../icons/icon-store.js'
import { loadBotProfileIcon, type BotProfileIconAgent } from './bot-profile-icon.js'
import type { SlackConfigApi } from './slack-config-api.js'

// Slack's apps.icon.set rejects icons smaller than 512x512.
const SLACK_APP_ICON_SIZE = 512

/** Render the Agent icon as the square PNG `apps.icon.set` accepts. */
export async function slackAppIconPng(agent: BotProfileIconAgent, iconStore?: IconStore): Promise<Buffer> {
  const source = await loadBotProfileIcon(agent, iconStore, SLACK_APP_ICON_SIZE)
  const { default: sharp } = await import('sharp')
  return sharp(source.bytes).resize(SLACK_APP_ICON_SIZE, SLACK_APP_ICON_SIZE, { fit: 'cover' }).png().toBuffer()
}

/** Best-effort: set a Slack app's icon to the Agent icon; returns the Slack error, or null on success. */
export async function syncSlackAppIcon(
  api: Pick<SlackConfigApi, 'setAppIcon'>,
  configToken: string,
  appId: string,
  agent: BotProfileIconAgent,
  iconStore?: IconStore
): Promise<string | null> {
  let png: Buffer
  try {
    png = await slackAppIconPng(agent, iconStore)
  } catch {
    return 'icon_unavailable'
  }
  const set = await api.setAppIcon(configToken, appId, png)
  return set.ok ? null : set.error
}
