/**
 * A connected workspace's TEAM conversation rows (linear-integration.md §4.3, §7.1, §9.2).
 *
 * A Linear team is a channel: it is the granularity at which a dispatch default and a trigger are
 * stored, edited and read, and every `created` / `prompted` payload carries `issue.team.id` as its
 * channel. The rows are written SYNCHRONOUSLY by the install paths, so a team's default is durable
 * before the first delegation can arrive — a default that waited on a live daemon would be missing
 * exactly when the first event lands.
 *
 * The seeding arms are the ordinary ones: the trigger is born `mention` when the owner is
 * unrestricted and `off` when it is gated (resource-visibility.md §14), and a later member's
 * sibling rows are the shared-bot replication `HttpBot` already performs on the next compile —
 * one trigger per team for the whole bot, never a per-member value.
 */
import type { AgentId, IntegrationId } from '../../domain/ids.js'
import { isGatedAgent } from '../../orchestrator/placement.js'
import type { AgentRecord, ChannelTrigger, IntegrationChannelRepo } from '../../persistence/ports.js'
import type { LinearTeam } from './api.js'

/** The console label for a team row: its issue prefix and its name, the two things a Linear
 *  operator identifies a team by. */
export const linearTeamChannelName = (team: LinearTeam): string => `${team.key} · ${team.name}`

/** What a freshly seeded team row's trigger is — the same §14 arm every other conversation seat
 *  takes. `any` has no Linear meaning: the platform emits no unaddressed traffic to opt into. */
export const linearTeamSeedTrigger = (owner: Pick<AgentRecord, 'visibility'>): ChannelTrigger =>
  isGatedAgent(owner) ? 'off' : 'mention'

/**
 * Write one OWNED row per team on one install — the connect tail's step (§7.1) and the reconciler
 * tick's seed for a team discovered later. Two writes per team because they carry different halves:
 * `upsertConversation` is the only one that takes the team NAME, `upsertAgent` the only one that
 * marks the owner. Ordered so the row is born with its trigger, which the ownership write preserves.
 */
export async function seedLinearTeamRows(
  channels: Pick<IntegrationChannelRepo, 'upsertConversation' | 'upsertAgent'>,
  integrationId: IntegrationId,
  owner: Pick<AgentRecord, 'id' | 'visibility'>,
  teams: readonly LinearTeam[]
): Promise<void> {
  const defaultTrigger = linearTeamSeedTrigger(owner)
  for (const team of teams) {
    await channels.upsertConversation(
      integrationId,
      { id: team.id, name: linearTeamChannelName(team), kind: 'channel' },
      { defaultTrigger }
    )
    await channels.upsertAgent(integrationId, team.id, owner.id as AgentId, { defaultTrigger, kind: 'channel' })
  }
}
