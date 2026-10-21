import { apiPut, orgBase } from '@/lib/api'

/** Replaces the app's Client Secret after the Control Plane checks it with DingTalk. */
export async function replaceDingTalkBotSecret(botId: string, clientSecret: string): Promise<void> {
  await apiPut(`${orgBase()}/bots/${encodeURIComponent(botId)}/dingtalk/credentials`, { clientSecret })
}
