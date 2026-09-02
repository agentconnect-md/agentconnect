// Linear's observed-channels strategy (linear-integration.md §4.5, §9.2): a Linear conversation
// is a TEAM, and the team rows are seeded by the CP's install paths and reconciler tick and
// refreshed by the connection's own team report — never rebuilt from session history. Folding
// history to nothing is what keeps the workspace-keyed channel of an issue-less session (and any
// pre-team-model session) from earning a row the CP's migration just deleted.
import type { ObservedChannelsStrategy } from '../observed-channels.js'

export const linearObservedChannels: ObservedChannelsStrategy = {
  platform: 'linear',
  collapse: async () => [],
  spaceFor: async () => undefined
}
