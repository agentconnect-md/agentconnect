// No 'use client' here: a pure input builder, imported from both client trees.

import type { CreateIntegrationInput } from '@/lib/api'

/** Link one agent to an already-connected workspace — Linear's only create shape (§7.1):
 *  the OAuth callback minted the bot, so no credentials, and no transport but `http`.
 *  One builder for `buildReuseInput` and the pane that commits a pick itself. */
export function linearLinkInput(agentId: string, botId: string): CreateIntegrationInput {
  return { platform: 'linear', agentId, botId, transport: 'http' }
}
