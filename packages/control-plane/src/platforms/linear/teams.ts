/**
 * A connected workspace's TEAM conversation rows (linear-integration.md §4.3, §7.1, §9.2).
 *
 * A Linear team is a channel: it is the granularity at which a dispatch default and a trigger are
 * stored, edited and read, and every `created` / `prompted` payload carries `issue.team.id` as its
 * channel. The rows are written SYNCHRONOUSLY by the install paths, so a team's default is durable
 * before the first delegation can arrive — a default that waited on a live daemon would be missing
 * exactly when the first event lands.
 *
 * The seeding arms are the ordinary ones: the trigger is born `mention` when some member could own
 * the row and `off` when every candidate is gated (resource-visibility.md §14), and a later
 * member's sibling rows are the shared-bot replication `HttpBot` already performs on the next
 * compile — one trigger per team for the whole bot, never a per-member value.
 */
import type { AgentId, IntegrationId } from '../../domain/ids.js'
import { isGatedAgent } from '../../orchestrator/placement.js'
import type { AgentRecord, ChannelTrigger, IntegrationChannelRepo } from '../../persistence/ports.js'
import type { LinearTeam } from './api.js'

/** What a Linear label joins the workspace and the team with — the daemon's own separator,
 *  because both sides write this one `integration_channel.name`. */
const LINEAR_LABEL_SEPARATOR = ' / '

/** One name as a label line: flattened and trimmed, the way the daemon flattens the same
 *  string, so the two writers of this row agree on an unusually spelled name. */
const flat = (raw: string | null | undefined): string => raw?.replace(/\s+/g, ' ').trim() ?? ''

/** The console label for a team row: the two NAMES an operator says out loud, never the issue
 *  prefix, which is an identifier. Same shape as the daemon's `linearChannelName` for the same
 *  team, so neither writer rewrites the other's row on the next pass. */
export const linearTeamChannelName = (team: LinearTeam, workspaceName?: string | null): string => {
  const space = flat(workspaceName)
  return space ? `${space}${LINEAR_LABEL_SEPARATOR}${flat(team.name)}` : flat(team.name)
}

/**
 * What a freshly seeded team row's trigger is — the same §14 arm every other conversation seat
 * takes, asked of the members that could own the row: `mention` when any of them is unrestricted,
 * `off` when they are all gated (and, fail-closed, when there are none). `any` has no Linear
 * meaning: the platform emits no unaddressed traffic to opt into.
 */
export const linearTeamSeedTrigger = (candidates: readonly Pick<AgentRecord, 'visibility'>[]): ChannelTrigger =>
  candidates.some((agent) => !isGatedAgent(agent)) ? 'mention' : 'off'

/**
 * Write one row per team on one install — the connect tail's step (§7.1) and the reconciler tick's
 * seed for a team discovered later. Two writes per team when there is an owner, because they carry
 * different halves: `upsertConversation` is the only one that takes the team NAME, `upsertAgent`
 * the only one that marks the owner. Ordered so the row is born with its trigger, which the
 * ownership write then preserves.
 *
 * `owner` is OPTIONAL, and its absence is a real state rather than a failure: a row whose owner
 * would be a member the route compile cannot route to must be born ownerless instead, because the
 * compile mutes a conversation whose persisted owner is not in its placed set. The compile
 * tolerates an ownerless row (it contributes no default and no route), the group's own
 * `defaultAgentId` keeps serving the team meanwhile, and an operator names the owner later.
 */
export async function seedLinearTeamRows(
  channels: Pick<IntegrationChannelRepo, 'upsertConversation' | 'upsertAgent'>,
  integrationId: IntegrationId,
  teams: readonly LinearTeam[],
  opts: { trigger: ChannelTrigger; owner?: AgentId; workspaceName?: string | null }
): Promise<void> {
  for (const team of teams) {
    await channels.upsertConversation(
      integrationId,
      { id: team.id, name: linearTeamChannelName(team, opts.workspaceName), kind: 'channel' },
      { defaultTrigger: opts.trigger }
    )
    if (!opts.owner) continue
    await channels.upsertAgent(integrationId, team.id, opts.owner, { defaultTrigger: opts.trigger, kind: 'channel' })
  }
}
