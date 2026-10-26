// The Decline click a capability card's private reply answers (capability-requests.md §4.4.3): platforms whose only private channel is the click's own response.

/** What the platform said about one click while core judges it: how to answer only the clicker, and who they are. */
export interface CapabilityClick {
  /** Collects a line only the clicker sees; the platform delivers what was collected once the decline is judged. */
  readonly reply: (text: string) => void
  readonly isBot?: boolean
  readonly name?: string
}

const clicks = new WeakMap<object, Map<string, CapabilityClick>>()

/** Run `judge` with this click registered on the connection it arrived on, and hand back every private line it produced. */
export async function withCapabilityClick(
  conn: object,
  userId: string,
  facts: { isBot?: boolean; name?: string },
  judge: () => Promise<unknown>
): Promise<string[]> {
  const told: string[] = []
  const click: CapabilityClick = { reply: (text) => void told.push(text), ...facts }
  let byUser = clicks.get(conn)
  if (!byUser) clicks.set(conn, (byUser = new Map()))
  byUser.set(userId, click)
  try {
    await judge()
  } finally {
    if (byUser.get(userId) === click) byUser.delete(userId)
  }
  return told
}

/** The click `userId` is making on `conn` right now, while its decline is judged. */
export function capabilityClick(conn: unknown, userId: string): CapabilityClick | undefined {
  return conn && typeof conn === 'object' ? clicks.get(conn)?.get(userId) : undefined
}
