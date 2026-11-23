import { apiPut, orgBase } from '@/lib/api'

/** Replaces a Mattermost bot's token; the Control Plane verifies it via `/api/v4/users/me` without interrupting the live WebSocket connection. */
export async function replaceMattermostBotToken(botId: string, botToken: string): Promise<void> {
  await apiPut(`${orgBase()}/bots/${encodeURIComponent(botId)}/mattermost/credentials`, { botToken })
}
