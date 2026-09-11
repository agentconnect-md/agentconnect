/**
 * The reactions one Gitea instance offers (gitea-integration.md §10.1): `GET /settings/ui` lists
 * `allowed_reactions`, read once per REST root and remembered, so an instance that removed `eyes`
 * gets no reaction rather than an error on every turn. A failed read is not remembered — the next
 * turn asks again — and a refusal the instance answers anyway evicts the entry the same way.
 */
import { giteaRequest, type GiteaApiClient } from './api.js'

const allowedByRoot = new Map<string, ReadonlySet<string>>()
const inflight = new Map<string, Promise<ReadonlySet<string> | undefined>>()

async function readAllowed(client: GiteaApiClient): Promise<ReadonlySet<string> | undefined> {
  const parsed = (await giteaRequest(client, { method: 'GET', path: '/settings/ui' })) as
    { allowed_reactions?: unknown } | undefined
  const list = parsed?.allowed_reactions
  return Array.isArray(list) ? new Set(list.filter((entry): entry is string => typeof entry === 'string')) : undefined
}

/** Whether the instance at `client.apiBaseUrl` offers `reaction`; false while its list cannot be read. */
export async function giteaReactionAllowed(client: GiteaApiClient, reaction: string): Promise<boolean> {
  const root = client.apiBaseUrl
  let allowed = allowedByRoot.get(root)
  if (!allowed) {
    let pending = inflight.get(root)
    if (!pending) {
      pending = readAllowed(client)
        .catch(() => undefined)
        .finally(() => inflight.delete(root))
      inflight.set(root, pending)
    }
    allowed = await pending
    if (!allowed) return false
    allowedByRoot.set(root, allowed)
  }
  return allowed.has(reaction)
}

/** Drop what is remembered for one instance, so the next acknowledgement re-reads its list. */
export function forgetGiteaReactions(apiBaseUrl: string): void {
  allowedByRoot.delete(apiBaseUrl)
}

/** Test seam: forget every instance. */
export function resetGiteaReactionCache(): void {
  allowedByRoot.clear()
  inflight.clear()
}
