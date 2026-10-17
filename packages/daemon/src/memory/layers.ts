// Which memory layer a conversation reads and writes, decided by its audience for every agent (unified-memory-interface.md §6).
import type { PlaceKind, ReadAsker, SourcePlace } from '../assistant/place-access.js'
import { kindFromRows } from '../mcp/ops/place-gate.js'
import type { NormalizedMessage } from '../messages/normalized.js'
import { confirmsInternalAudience } from '../platforms/read-ports.js'
import {
  adoptMemoryLayer,
  CHANNEL_MEMORY_DIRNAME,
  memoryChannelKey,
  memoryPersonKey,
  PERSON_MEMORY_DIRNAME,
  placeLayerMeta,
  writeChannelMemoryMeta,
  type MemoryFs
} from './store.js'
import type { MemoryScope } from './types.js'

/** Where a conversation's memory goes beside nothing else: the shared layer, its person's layer, or its own place layer. */
export type MemoryLayer = 'shared' | 'person' | 'place'

export { MEMORY_LAYER_CHOICES, type MemoryLayerChoice } from './types.js'

/** How long a chat member's linked console account is trusted before the Control Plane is asked again. */
export const LINKED_PERSON_TTL_MS = 10 * 60_000
const MAX_LINKED_ENTRIES = 1024
const MAX_PEER_ENTRIES = 1024

/** A conversation as the layer rule reads it. */
export interface MemoryPlace {
  agentId: string
  platform: string
  channel: string
  transportScope?: string | null
  /** Its recorded or observed conversation kinds; the strictest wins. */
  kinds: readonly (string | null | undefined)[]
  /** Who typed the message at hand, when a person did. */
  speaker?: string
  /** Whoever opened the session, as its row records: a person, or an automation's id that never counts as one. */
  opener?: string | null
}

/** The layer a conversation uses and the scope that reaches it. */
export interface ResolvedMemoryLayer {
  layer: MemoryLayer
  scope: MemoryScope
}

/** A conversation's layer, and whether it is known to hold people from outside the organization. */
export interface PlaceAudience {
  layer: MemoryLayer
  external: boolean
  /** Whether `external` is an answer rather than a default: a platform that described the place, a DM, or no conversation at all. */
  confirmed?: boolean
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
  /** Whether the agent already knows the conversation is shared with another organization or holds a guest. */
  external(agentId: string, integrationId: string | undefined, channel: string): boolean
  /** The integration's durable tenant scope, part of a chat member's identity. */
  tenantScope(integrationId: string): Promise<string | undefined>
  /** Who opened the agent's other sessions in this conversation, newest first. */
  earlierSenders(place: MemoryPlace): Promise<string[]>
  /** The person a 1:1 DM is with, as its platform names them. */
  dmPeer?(integrationId: string, channel: string): Promise<string | undefined>
  /** The console user a chat member linked, or undefined when unlinked; rejects when the Control Plane cannot be asked. */
  linkedConsoleUser(agentId: string, integrationId: string, memberId: string): Promise<string | undefined>
  /** The agent's live memory tree for the one-time folder moves; undefined when it is out of reach. */
  memoryTree(agentId: string): MemoryFs | undefined
  /** The conversation's display name as this daemon last saw it, recorded with its place layer. */
  placeName?(place: MemoryPlace): Promise<string | undefined>
  /** A person's platform identity now resolves to their console account: what is kept under the one follows to the other. */
  linked?(agentId: string, platformIdentity: string, identity: string): Promise<void>
  now(): number
  log?(message: string): void
}

/** Whether People is withheld here (assistant-mode.md §5.16): people from outside, or an audience not confirmed yet. */
export function withholdsPeople(audience: PlaceAudience): boolean {
  return audience.external || audience.confirmed !== true
}

/** An id that can stand in an identity: no whitespace, no separator. */
const usableId = (id: string | null | undefined): id is string => !!id && !/[\s:]/.test(id)

// Agent ids are UUIDs (the protocol's AgentId); a schedule's or hook's trigger id carries a colon.
const AGENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Whether a person typed a message: a check's, a task's, a report's, another agent's or a schedule's never counts. */
export function typedByPerson(msg: Pick<NormalizedMessage, 'source' | 'sender' | 'headless'>): boolean {
  return msg.source === 'user' && !msg.sender.isBot && !msg.headless && !!msg.sender.id
}

/** Whether an initiator is a person: never an agent (a check's, a task's, another agent's message) or an automation trigger. */
export function personId(id: string | null | undefined): id is string {
  return usableId(id) && !AGENT_ID.test(id)
}

/** The audience test: shared only where an internal audience is confirmed, a 1:1 DM or a console conversation is its person's, anything else keeps its own. */
export function layerOfPlace(place: SourcePlace, knownExternal: boolean): MemoryLayer {
  if (place.kind === 'webchat' || place.kind === 'dm') return 'person'
  // Unknown sharing is not internal: only a listing or a lookup that found no share confirms it.
  if (place.kind !== 'channel' || place.private !== false || knownExternal || place.external !== false) return 'place'
  return confirmsInternalAudience(place.platform) ? 'shared' : 'place'
}

export class MemoryLayers {
  private readonly linked = new Map<string, { at: number; consoleUserId: string | null }>()
  private readonly adopted = new Set<string>()
  private readonly peers = new Map<string, string>()

  constructor(private readonly deps: MemoryLayerDeps) {}

  /** The layer a conversation's memory goes to; a place that cannot be described keeps its own. */
  async layerOf(place: MemoryPlace): Promise<MemoryLayer> {
    return (await this.audienceOf(place)).layer
  }

  /** Its layer, and whether it is known to hold people from outside: shared with another organization, or a known guest. */
  async audienceOf(place: MemoryPlace): Promise<PlaceAudience> {
    if (place.platform === 'webchat') return { layer: 'person', external: false, confirmed: true }
    // A code-host review or an internal pass is no conversation: what it learns is the organization's.
    if (!this.deps.chatPlatform(place.platform)) return { layer: 'shared', external: false, confirmed: true }
    const integrationId = this.deps.integrationFor(place.agentId, place.platform, place.transportScope)
    const known = this.deps.external(place.agentId, integrationId, place.channel)
    const rowKind = kindFromRows(place.platform, place.kinds)
    // A DM never turns external (assistant-mode.md §5.3); a group DM's members are not described, so only a known guest settles it.
    if (rowKind === 'dm') return { layer: 'person', external: known, confirmed: true }
    if (rowKind === 'group_dm') return { layer: 'place', external: known, confirmed: known }
    const described = await this.deps
      .describe({ platform: place.platform, channel: place.channel }, rowKind, integrationId)
      .catch(() => ({ platform: place.platform, channel: place.channel }) as SourcePlace)
    return {
      layer: layerOfPlace(described, known),
      external: known || described.external === true,
      confirmed: known || described.external !== undefined
    }
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
    if (layer === 'place') return { layer, scope: await this.named(placeScope, place) }
    const person = await this.personOfPlace(place)
    if (!person) return { layer: 'place', scope: await this.named(placeScope, place) }
    const personKey = await this.settle(place.agentId, person, own)
    return { layer, scope: { agentId: place.agentId, personKey } }
  }

  /** Record a place layer's platform and current name again before a write, so a renamed conversation reads right; best-effort. */
  async notePlace(scope: MemoryScope): Promise<void> {
    const meta = placeLayerMeta(scope)
    const tree = meta ? this.deps.memoryTree(scope.agentId) : undefined
    if (meta && tree) await writeChannelMemoryMeta(tree, meta.channelKey, meta).catch(() => {})
  }

  /** A place layer's scope with what names it: its platform, and its display name when this daemon knows one. */
  private async named(scope: MemoryScope, place: MemoryPlace): Promise<MemoryScope> {
    const name = await this.deps.placeName?.(place).catch(() => undefined)
    return { ...scope, platform: place.platform, ...(name ? { channelName: name } : {}) }
  }

  /** The asker's own person layer, for a tool's `layer: 'person'`; undefined when they cannot be told. */
  async personScope(agentId: string, asker: ReadAsker): Promise<MemoryScope | undefined> {
    const person =
      asker.kind === 'console'
        ? personId(asker.userId)
          ? { identity: `user:${asker.userId}` }
          : undefined
        : await this.memberIdentity(agentId, asker.platform, asker.integrationId, asker.userId)
    if (!person) return undefined
    return { agentId, personKey: await this.settle(agentId, person) }
  }

  /** The keys a DM's or console conversation's person is known by, theirs first: the console account when linked, else the platform identity. */
  async personKeys(place: MemoryPlace): Promise<string[]> {
    const person = await this.personOfPlace(place)
    return person ? [...new Set([person.identity, ...(person.platformIdentity ? [person.platformIdentity] : [])])] : []
  }

  /** The keys a chat member is known by: their platform identity, and their console account's when they linked one. */
  async memberKeys(agentId: string, platform: string, integrationId: string, uid: string): Promise<string[]> {
    const person = await this.memberIdentity(agentId, platform, integrationId, uid)
    return person ? [...new Set([person.platformIdentity, person.identity])] : []
  }

  /** The console key a chat member linked, from the same cache their layer uses. */
  async linkedConsoleKey(agentId: string, integrationId: string, uid: string): Promise<string | undefined> {
    if (!personId(uid)) return undefined
    const consoleUserId = await this.linkedConsoleUser(agentId, integrationId, uid)
    return usableId(consoleUserId) ? `user:${consoleUserId}` : undefined
  }

  /** The person a DM or a console conversation belongs to, from what a person did there and never from an automation. */
  private async personOfPlace(
    place: MemoryPlace
  ): Promise<{ identity: string; platformIdentity?: string } | undefined> {
    const earlier = async () => (await this.deps.earlierSenders(place).catch(() => [])).find(personId)
    if (place.platform === 'webchat') {
      // The conversation's owner opened it; the person typing stands in on its first turn.
      const owner = [place.opener, place.speaker].find(personId) ?? (await earlier())
      return owner ? { identity: `user:${owner}` } : undefined
    }
    const integrationId = this.deps.integrationFor(place.agentId, place.platform, place.transportScope)
    if (!integrationId) return undefined
    // A 1:1 DM is with one person: whoever typed here, else whom the platform says it is with, else who opened it.
    let uid = personId(place.speaker) ? place.speaker : undefined
    uid ??= await this.dmPeer(integrationId, place.channel)
    if (!uid && personId(place.opener)) uid = place.opener
    uid ??= await earlier()
    return uid ? await this.memberIdentity(place.agentId, place.platform, integrationId, uid) : undefined
  }

  /** The platform's answer on whom a DM is with, kept: it never changes. */
  private async dmPeer(integrationId: string, channel: string): Promise<string | undefined> {
    const key = `${integrationId}\u001f${channel}`
    const known = this.peers.get(key)
    if (known) return known
    const peer = await this.deps.dmPeer?.(integrationId, channel).catch(() => undefined)
    if (!personId(peer)) return undefined
    this.peers.set(key, peer)
    if (this.peers.size > MAX_PEER_ENTRIES) {
      const oldest = this.peers.keys().next().value
      if (oldest !== undefined) this.peers.delete(oldest)
    }
    return peer
  }

  /** A chat member's identity: their linked console account when they have one, else their platform identity. */
  private async memberIdentity(
    agentId: string,
    platform: string,
    integrationId: string,
    uid: string
  ): Promise<{ identity: string; platformIdentity: string } | undefined> {
    const tenant = await this.deps.tenantScope(integrationId).catch(() => undefined)
    if (!personId(uid) || !tenant || /\s/.test(tenant)) return undefined
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
      if (person.platformIdentity && person.platformIdentity !== person.identity)
        await this.deps.linked?.(agentId, person.platformIdentity, person.identity)
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
