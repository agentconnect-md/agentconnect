/** The one definition of an active membership: a suspended row stays in the table and reads as absent to every access check. */
export const ACTIVE_MEMBERSHIP = { suspendedAt: null } as const
