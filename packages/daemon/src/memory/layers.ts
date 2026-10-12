// Which memory layer a conversation reads and writes, decided by its audience for every agent (unified-memory-interface.md §6).
import type { PlaceKind, ReadAsker, SourcePlace } from '../assistant/place-access.js'
import { kindFromRows } from '../mcp/ops/place-gate.js'
import { confirmsInternalAudience } from '../platforms/read-ports.js'
import {
  adoptMemoryLayer,
  CHANNEL_MEMORY_DIRNAME,
  memoryChannelKey,
  memoryPersonKey,
  PERSON_MEMORY_DIRNAME,
  type MemoryFs
} from './store.js'
import type { MemoryScope } from './types.js'

/** Where a conversation's memory goes beside nothing else: the shared layer, its person's layer, or its own place layer. */
export type MemoryLayer = 'shared' | 'person' | 'place'

export { MEMORY_LAYER_CHOICES, type MemoryLayerChoice } from './types.js'

/** How long a chat member's linked console account is trusted before the Control Plane is asked again. */
export const LINKED_PERSON_TTL_MS = 10 * 60_000
const MAX_LINKED_ENTRIES = 1024

/** A conversation as the layer rule reads it. */
export interface MemoryPlace {
  agentId: string
  platform: string
  channel: string
  transportScope?: string | null
  /** Its recorded or observed conversation kinds; the strictest wins. */
  kinds: readonly (string | null | undefined)[]
  /** Platform or console user ids that may be its person, best first: the row's first sender, the turn's sender. */
  people: readonly (string | null | undefined)[]
}

/** The layer a conversation uses and the scope that reaches it. */
export interface ResolvedMemoryLayer {
  layer: MemoryLayer
  scope: MemoryScope
}

export interface MemoryLayerDeps {
  /** Whether sessions on this platform are conversations at all: a chat platform's or webchat's, never a code host's. */
  chatPlatform(platform: string): boolean
  /** The agent's integration a conversation was reached through. */
  integrationFor(agentId: string, platform: string, transportScope?: string | null): string | undefined
  /** The conversation's kind and privacy, from its rows, the snapshot, then the platform. */
  describe(
    place: { platform: string; channel: string },
    kind: PlaceKind | undefined,
    integrationId?: string
  ): Promise<SourcePlace>
  /** Whether the conversation is shared with another organization or holds a detected guest. */
  external(agentId: string, integrationId: string | undefined, channel: string): boolean
  /** The integration's durable tenant scope, part of a chat member's identity. */
  tenantScope(integrationId: string): Promise<string | undefined>
  /** Who wrote in this conversation before, newest first, when its own row names no person. */
  earlierSenders(place: MemoryPlace): Promise<string[]>
  /** A 1:1 DM's other member, from the platform, when nothing recorded names them. */
  dmPeer?(integrationId: string, channel: string): Promise<string | undefined>
  /** The console user a chat member linked, or undefined when unlinked; rejects when the Control Plane cannot be asked. */
  linkedConsoleUser(agentId: string, integrationId: string, memberId: string): Promise<string | undefined>
  /** The agent's live memory tree for the one-time folder moves; undefined when it is out of reach. */
  memoryTree(agentId: string): MemoryFs | undefined
  now(): number
  log?(message: string): void
}

/** An id that can stand in an identity: no whitespace, no separator. */
const usableId = (id: string | null | undefined): id is string => !!id && !/[\s:]/.test(id)

/** The audience test: a public channel confirmed internal shares, a 1:1 DM or a console conversation is its person's, anything else keeps its own. */
export function layerOfPlace(place: SourcePlace, external: boolean): MemoryLayer {
  if (place.kind === 'webchat' || place.kind === 'dm') return 'person'
  if (place.kind !== 'channel' || place.private !== false || external) return 'place'
  return confirmsInternalAudience(place.platform) ? 'shared' : 'place'
}

export class MemoryLayers {
  private readonly linked = new Map<string, { at: number; consoleUserId: string | null }>()
  private readonly adopted = new Set<string>()

  constructor(private readonly deps: MemoryLayerDeps) {}

  /** The layer a conversation's memory goes to; a place that cannot be described keeps its own. */
  async layerOf(place: MemoryPlace): Promise<MemoryLayer> {
    if (place.platform === 'webchat') return 'person'
    // A code-host review or an internal pass is no conversation: what it learns is the organization's.
    if (!this.deps.chatPlatform(place.platform)) return 'shared'
    const rowKind = kindFromRows(place.platform, place.kinds)
    if (rowKind === 'dm') return 'person'
    if (rowKind === 'group_dm') return 'place'
    const integrationId = this.deps.integrationFor(place.agentId, place.platform, place.transportScope)
    const described = await this.deps
      .describe({ platform: place.platform, channel: place.channel }, rowKind, integrationId)
      .catch(() => ({ platform: place.platform, channel: place.channel }) as SourcePlace)
    return layerOfPlace(described, this.deps.external(place.agentId, integrationId, place.channel))
  }

  /** The layer and its scope; a 1:1 DM whose person cannot be told keeps a place layer of its own. */
  async resolve(place: MemoryPlace): Promise<ResolvedMemoryLayer> {
    const layer = await this.layerOf(place)
    const own = memoryChannelKey(place.channel, place.transportScope ?? undefined)
    const placeScope: MemoryScope = {
      agentId: place.agentId,
      channelKey: own,
      channel: place.channel,
      ...(place.transportScope ? { transportScope: place.transportScope } : {})
    }
    if (layer === 'shared') {
      // A shared channel's own older folder stays readable beneath the shared layer.
      const chat = place.platform !== 'webchat' && this.deps.chatPlatform(place.platform)
      return { layer, scope: chat ? { ...placeScope, sharedPlace: true } : { agentId: place.agentId } }
    }
    if (layer === 'place') return { layer, scope: placeScope }
    const person = await this.personOfPlace(place)
    if (!person) return { layer: 'place', scope: placeScope }
    const personKey = await this.settle(place.agentId, person, own)
    return { layer, scope: { agentId: place.agentId, personKey } }
  }

  /** The asker's own person layer, for a tool's `layer: 'person'`; undefined when they cannot be told. */
  async personScope(agentId: string, asker: ReadAsker): Promise<MemoryScope | undefined> {
    const person =
      asker.kind === 'console'
        ? usableId(asker.userId)
          ? { identity: `user:${asker.userId}` }
          : undefined
        : await this.memberIdentity(agentId, asker.platform, asker.integrationId, asker.userId)
    if (!person) return undefined
    return { agentId, personKey: await this.settle(agentId, person) }
  }

  /** The person a DM or a console conversation belongs to, as an identity. */
  private async personOfPlace(
    place: MemoryPlace
  ): Promise<{ identity: string; platformIdentity?: string } | undefined> {
    if (place.platform === 'webchat') {
      const owner = place.people.find(usableId)
      return owner ? { identity: `user:${owner}` } : undefined
    }
    const integrationId = this.deps.integrationFor(place.agentId, place.platform, place.transportScope)
    if (!integrationId) return undefined
    let uid = place.people.find(usableId)
    uid ??= (await this.deps.earlierSenders(place).catch(() => [])).find(usableId)
    if (!uid && this.deps.dmPeer) uid = await this.deps.dmPeer(integrationId, place.channel).catch(() => undefined)
    return usableId(uid) ? await this.memberIdentity(place.agentId, place.platform, integrationId, uid) : undefined
  }

  /** A chat member's identity: their linked console account when they have one, else their platform identity. */
  private async memberIdentity(
    agentId: string,
    platform: string,
    integrationId: string,
    uid: string
  ): Promise<{ identity: string; platformIdentity: string } | undefined> {
    const tenant = await this.deps.tenantScope(integrationId).catch(() => undefined)
    if (!usableId(uid) || !tenant || /\s/.test(tenant)) return undefined
    const platformIdentity = `${platform}:${tenant}:${uid}`
    const consoleUserId = await this.linkedConsoleUser(agentId, integrationId, uid)
    return { identity: usableId(consoleUserId) ? `user:${consoleUserId}` : platformIdentity, platformIdentity }
  }

  /** Cached; when the Control Plane cannot answer, the last answer stands, else the member counts as unlinked. */
  private async linkedConsoleUser(agentId: string, integrationId: string, uid: string): Promise<string | undefined> {
    const key = `${agentId}\u001f${integrationId}\u001f${uid}`
    const hit = this.linked.get(key)
    if (hit && this.deps.now() - hit.at < LINKED_PERSON_TTL_MS) return hit.consoleUserId ?? undefined
    try {
      const consoleUserId = (await this.deps.linkedConsoleUser(agentId, integrationId, uid)) ?? null
      this.linked.delete(key)
      this.linked.set(key, { at: this.deps.now(), consoleUserId })
      if (this.linked.size > MAX_LINKED_ENTRIES) {
        const oldest = this.linked.keys().next().value
        if (oldest !== undefined) this.linked.delete(oldest)
      }
      return consoleUserId ?? undefined
    } catch {
      return hit?.consoleUserId ?? undefined
    }
  }

  /** The person's folder key, moving an older folder onto it once while it is empty: a platform-keyed one on linking, else the DM's own. */
  private async settle(
    agentId: string,
    person: { identity: string; platformIdentity?: string },
    ownFolder?: string
  ): Promise<string> {
    const personKey = memoryPersonKey(person.identity)
    const memo = `${agentId}\u0000${personKey}`
    if (this.adopted.has(memo)) return personKey
    const tree = this.deps.memoryTree(agentId)
    if (!tree) return personKey
    const target = `${PERSON_MEMORY_DIRNAME}/${personKey}`
    const sources = [
      person.platformIdentity && person.platformIdentity !== person.identity
        ? `${PERSON_MEMORY_DIRNAME}/${memoryPersonKey(person.platformIdentity)}`
        : undefined,
      ownFolder ? `${CHANNEL_MEMORY_DIRNAME}/${ownFolder}` : undefined
    ].filter((from): from is string => from !== undefined)
    try {
      for (const from of sources) {
        if (await adoptMemoryLayer(tree, from, target)) {
          this.deps.log?.(`memory: agent "${agentId}" moved an earlier memory folder onto a person layer`)
          break
        }
      }
      this.adopted.add(memo)
    } catch {
      // The home is out of reach: nothing moved, and the next resolution tries again.
    }
    return personKey
  }
}

/** The layer folder a scope writes, for logs and tests: `shared`, `channels/<key>` or `people/<key>`. */
export function memoryLayerFolder(scope: MemoryScope): string {
  if (scope.personKey) return `${PERSON_MEMORY_DIRNAME}/${scope.personKey}`
  if (scope.channelKey && !scope.sharedPlace) return `${CHANNEL_MEMORY_DIRNAME}/${scope.channelKey}`
  return 'shared'
}
