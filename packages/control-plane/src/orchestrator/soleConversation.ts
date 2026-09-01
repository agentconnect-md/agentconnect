/**
 * The install-time conversation row for a platform whose install NAMES the one conversation it
 * can reach (§5 `soleConversation`) — today a connected Linear workspace.
 *
 * Written SYNCHRONOUSLY by the install paths, so the caller's own `syncBot` publishes the routes
 * that follow from it and there is no window where an agent is linked but unroutable. The daemon's
 * later observed report is a NAME refresh and a backstop only: the `integration/channels` wire
 * report carries no trigger and `replaceSnapshot` preserves the stored one, so a report can never
 * undo this seed.
 *
 * Born 'mention', restricted agent or not: linking the agent to the workspace IS the
 * per-conversation consent, which is the same rule `gatesNewConversations` states for every other
 * seat that seeds a trigger.
 */
import type { AgentId, IntegrationId } from '../domain/ids.js'
import { manifestFor } from '@agentconnect.md/protocol'
import type { BotRecord, IntegrationChannelRepo, IntegrationRecord } from '../persistence/ports.js'

/** The conversation an install names, or undefined when this platform names none. */
export function soleConversationOf(
  bot: Pick<BotRecord, 'platform' | 'workspaceId' | 'workspaceName'>
): { id: string; name?: string } | undefined {
  if (!manifestFor(bot.platform).soleConversation) return undefined
  const id = bot.workspaceId
  if (!id) return undefined
  return { id, ...(bot.workspaceName ? { name: bot.workspaceName } : {}) }
}

/**
 * Seed the row for an ADDED member. Deliberately ownerless: the conversation already has an owner
 * and adding a member must not steal it — the new row exists so the console can show and configure
 * the workspace for this install too.
 */
export async function seedSoleConversationMember(
  channels: IntegrationChannelRepo,
  integration: Pick<IntegrationRecord, 'id'>,
  bot: Pick<BotRecord, 'platform' | 'workspaceId' | 'workspaceName'>
): Promise<void> {
  const conversation = soleConversationOf(bot)
  if (!conversation) return
  await channels.upsertConversation(
    integration.id as IntegrationId,
    { ...conversation, kind: 'channel' },
    { defaultTrigger: 'mention' }
  )
}

/**
 * Seed the row for a FIRST member — the install that minted the bot. It takes ownership, so the
 * compile has a workspace default to publish on this same request.
 */
export async function seedSoleConversationOwner(
  channels: IntegrationChannelRepo,
  integration: Pick<IntegrationRecord, 'id' | 'agentId'>,
  bot: Pick<BotRecord, 'platform' | 'workspaceId' | 'workspaceName'>
): Promise<void> {
  const conversation = soleConversationOf(bot)
  if (!conversation) return
  // Two writes because they carry different halves: `upsertConversation` is the only one that
  // takes the workspace NAME, `upsertAgent` the only one that marks the owner. Ordered so the
  // row is born with its trigger, which the ownership write then preserves.
  await seedSoleConversationMember(channels, integration, bot)
  await channels.upsertAgent(integration.id as IntegrationId, conversation.id, integration.agentId as AgentId, {
    defaultTrigger: 'mention',
    kind: 'channel'
  })
}
