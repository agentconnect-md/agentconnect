import type { ChatAuthoritySource } from '../../src/orchestrator/placement.js'

/** An organization that syncs no platform's session access, so every projected spec lets anyone in a conversation act. */
export const NO_SESSION_SYNC: ChatAuthoritySource = { getExternalAccessPolicy: async () => null }
