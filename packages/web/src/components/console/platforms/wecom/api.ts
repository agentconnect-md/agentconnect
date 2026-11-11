import { apiPut, orgBase } from '@/lib/api'

/** Replaces the smart bot's Secret; the Control Plane stores it untested, since a check would evict the running connection. */
export async function replaceWeComBotSecret(botId: string, secret: string): Promise<void> {
  await apiPut(`${orgBase()}/bots/${encodeURIComponent(botId)}/wecom/credentials`, { secret })
}
