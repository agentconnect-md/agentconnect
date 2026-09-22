import { apiPut, orgBase } from '@/lib/api'

export async function updateQQBotCredentials(botId: string, appSecret: string): Promise<void> {
  await apiPut(`${orgBase()}/bots/${encodeURIComponent(botId)}/qq/credentials`, { appSecret })
}
