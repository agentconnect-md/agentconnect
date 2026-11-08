import { TaskInitiator } from '@agentconnect.md/protocol'

/** A public name, with an address reduced to its local name when no display name was available. */
export function initiatorName(name: string): string {
  return (
    name
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^([^\s@]+)@[^\s@]+$/, '$1')
      .slice(0, 180) || 'Unknown user'
  )
}

/** The persisted snapshot is JSON text on both daemon stores. */
export function sessionInitiator(session: { initiator?: string | null } | undefined): TaskInitiator | undefined {
  if (!session?.initiator) return undefined
  try {
    const parsed = TaskInitiator.safeParse(JSON.parse(session.initiator))
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}
