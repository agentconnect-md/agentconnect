/**
 * The AgentConnect Feishu/Lark one-click app template.
 *
 * This is the single reviewable list of capabilities added to Feishu's
 * official PersonalAgent base. The provider confirmation page shows this
 * template before creating the app.
 */
import { gzipSync } from 'node:zlib'
import {
  DEFAULT_PLATFORM_APP_DESCRIPTION,
  LARK_APP_DESCRIPTION_MAX_LENGTH,
  platformAppDescription
} from './platform-app-description.js'

export const AGENTCONNECT_FEISHU_SCOPES = [
  'contact:contact.base:readonly',
  'contact:user.base:readonly',
  'im:chat:read',
  'im:chat.members:bot_access',
  'im:message',
  'im:message.group_at_msg:readonly',
  'im:message.p2p_msg:readonly',
  'im:message:send_as_bot',
  'im:resource'
] as const

export const AGENTCONNECT_FEISHU_EVENTS = ['im.message.receive_v1'] as const
export const AGENTCONNECT_FEISHU_CALLBACKS = ['card.action.trigger'] as const

export const AGENTCONNECT_FEISHU_APP_TEMPLATE = {
  archetype: 'PersonalAgent',
  description: DEFAULT_PLATFORM_APP_DESCRIPTION,
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
  description?: string | null
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
  url.searchParams.set('desc', platformAppDescription(preset.description, LARK_APP_DESCRIPTION_MAX_LENGTH))
  url.searchParams.set('addons', encodeAddons())
  url.searchParams.set('createOnly', 'true')
  return url.toString()
}
