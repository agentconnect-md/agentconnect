/**
 * The AgentConnect Feishu/Lark one-click app template.
 *
 * This is the single reviewable list of capabilities added to Feishu's
 * official PersonalAgent base. The provider confirmation page shows this
 * template before creating the app.
 */
import { gzipSync } from 'node:zlib'
import { PLATFORM_APP_DESCRIPTION } from './platform-app-description.js'

export const AGENTCONNECT_FEISHU_SCOPES = [
  'application:application:patch',
  'application:application:self_manage',
  'contact:contact.base:readonly',
  'contact:user.base:readonly',
  'im:chat:read',
  'im:chat.members:bot_access',
  'im:chat.members:read',
  'im:message',
  'im:message.group_msg',
  'im:message.group_at_msg:readonly',
  'im:message.p2p_msg:readonly',
  'im:message:send_as_bot',
  'im:resource',
  'tenant:tenant:readonly'
] as const

export const AGENTCONNECT_FEISHU_EVENTS = ['im.message.receive_v1'] as const
export const AGENTCONNECT_FEISHU_CALLBACKS = ['card.action.trigger'] as const

export const AGENTCONNECT_FEISHU_APP_TEMPLATE = {
  archetype: 'PersonalAgent',
  description: PLATFORM_APP_DESCRIPTION,
  addons: {
    preset: true,
    scopes: { tenant: [...AGENTCONNECT_FEISHU_SCOPES] },
    events: { items: { tenant: [...AGENTCONNECT_FEISHU_EVENTS] } },
    callbacks: { items: [...AGENTCONNECT_FEISHU_CALLBACKS] }
  }
} as const

function encodeAddons(): string {
  const json = JSON.stringify(AGENTCONNECT_FEISHU_APP_TEMPLATE.addons)
  return gzipSync(Buffer.from(json, 'utf8'))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

export interface FeishuAppPreset {
  avatarUrl?: string
}

export function buildFeishuAuthorizationUrl(
  verificationUri: string,
  appName: string,
  preset: FeishuAppPreset = {}
): string {
  const url = new URL(verificationUri)
  url.searchParams.set('from', 'sdk')
  url.searchParams.set('source', 'node-sdk/agentconnect')
  url.searchParams.set('tp', 'sdk')
  if (preset.avatarUrl) url.searchParams.set('avatar', preset.avatarUrl)
  url.searchParams.set('name', appName)
  url.searchParams.set('desc', PLATFORM_APP_DESCRIPTION)
  url.searchParams.set('addons', encodeAddons())
  url.searchParams.set('createOnly', 'true')
  return url.toString()
}
