import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { ShimCapability } from './protocol.js'

/** What the daemon knows about a sandbox it launched before dialing its shim. */
export interface SpawnRecord {
  agentId: string
  /** What the pod is claimed for — the agent, or one of its confined sessions; absent means the agent's own pod. */
  subject?: string
  /** Sandbox object UID — from the Sandbox's own `metadata.uid`; the claim has none. */
  sandboxUid: string
  /** Monotonic per-agent counter, incremented on every launch of a new pod. */
  generation: number
  /** Capabilities this launch may exercise, decided by the daemon at spawn time. */
  grants: ShimCapability[]
  /** The pod backing this launch, matched exactly against the dialed shim's TokenReview identity. */
  podName: string
}

/** A bound shim connection: the pod that proved its identity plus what it may do. */
export interface Binding extends SpawnRecord {
  podName: string
  podUid: string
  expiresAtMs: number
}

export type AuthorizeFailure =
  'unknown_credential' | 'expired_credential' | 'stale_generation' | 'capability_not_granted'

export type AuthorizeResult = { ok: true; binding: Binding } | { ok: false; failure: AuthorizeFailure }

export type BindResult =
  | { ok: true; credential: string; binding: Binding; superseded: Binding[] }
  /** A newer launch already holds this sandbox's channel; the caller must not bind. */
  | { ok: false; reason: 'superseded_generation' | 'generation_claimed_by_another_pod'; current: number }

/** The launch identity a record binds: its subject, which for the agent's own pod is the agent id. */
export function spawnSubject(record: Pick<SpawnRecord, 'agentId' | 'subject'>): string {
  return record.subject ?? record.agentId
}

/** Constant-time compare that cannot throw on a length mismatch. */
function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/**
 * The bindings a daemon has issued, and the single place every shim invariant is
 * enforced.
 *
 * Deliberately one predicate rather than checks spread across call sites: the
 * invariants are only as strong as their weakest enforcement point, so `authorize`
 * is the sole gate and every channel goes through it. Adding a channel cannot
 * accidentally skip the generation fence or the capability check, because there is
 * no other way to resolve a credential into a binding.
 */
export class ShimBindingRegistry {
  private readonly byCredential = new Map<string, Binding>()
  /** Credential per bound pod UID, for revoking one incarnation by identity. */
  private readonly credentialByPod = new Map<string, string>()

  constructor(
    private readonly now: () => number,
    private readonly ttlMs: number
  ) {}

  /**
   * Issue a credential for a pod that proved its identity and matched a spawn record.
   * The credential is the only thing the shim ever holds: short-lived, bound to this pod
   * and generation, re-obtained by re-handshaking, so no long-lived credential is in the
   * sandbox.
   *
   * Binding supersedes every earlier binding for the same launch identity — the subject's
   * sandbox — NOT merely the same pod UID. A rescheduled or resumed pod arrives with a
   * NEW UID, so keying supersession on the pod would leave the evicted incarnation's
   * credential live and its generation authorized: precisely the replay the fence exists
   * to stop. The superseded bindings are returned so the caller can close their channels.
   */
  bind(record: SpawnRecord, pod: { name: string; uid: string }): BindResult {
    const superseded: Binding[] = []
    for (const [credential, existing] of [...this.byCredential]) {
      if (spawnSubject(existing) !== spawnSubject(record) || existing.sandboxUid !== record.sandboxUid) continue
      // Monotonic in the generation, mutating nothing when it is not: an older incarnation
      // can bind AFTER a newer one — a terminating pod reconnecting during overlap, or
      // simply a slower TokenReview — and replacing the current binding would hand the
      // channel back to the sandbox that is going away.
      if (existing.generation > record.generation) {
        return { ok: false, reason: 'superseded_generation', current: existing.generation }
      }
      // Equal generation is the ordinary case, not a duplicate: the generation counts pod
      // launches, while a credential renewal at half TTL and a reconnect after a dropped
      // socket both happen inside the SAME pod. Refusing it would strand a healthy pod
      // permanently unbindable. Equal generation from a DIFFERENT pod is the ambiguous one
      // — two pods claiming one launch — and stays refused.
      if (existing.generation === record.generation && existing.podUid !== pod.uid) {
        return { ok: false, reason: 'generation_claimed_by_another_pod', current: existing.generation }
      }
      superseded.push(existing)
      this.byCredential.delete(credential)
      this.credentialByPod.delete(existing.podUid)
    }
    const credential = randomBytes(32).toString('base64url')
    const binding: Binding = {
      ...record,
      grants: [...record.grants],
      podName: pod.name,
      podUid: pod.uid,
      expiresAtMs: this.now() + this.ttlMs
    }
    this.byCredential.set(credential, binding)
    this.credentialByPod.set(pod.uid, credential)
    return { ok: true, credential, binding, superseded }
  }

  /**
   * Resolve a frame's credential into a binding, or say why not. Checks, in order:
   * the credential exists (constant-time), has not expired, the frame's generation is
   * the bound one, and the capability was granted to this launch.
   *
   * The generation check is what makes a replayed frame from a previous pod
   * incarnation useless: resume and eviction both produce a new generation, and the
   * old credential is dropped when the same pod re-binds.
   */
  authorize(input: { credential: string; generation: number; capability: ShimCapability }): AuthorizeResult {
    const match = this.find(input.credential)
    if (!match) return { ok: false, failure: 'unknown_credential' }
    if (this.now() >= match.expiresAtMs) {
      this.revokeCredential(input.credential)
      return { ok: false, failure: 'expired_credential' }
    }
    if (input.generation !== match.generation) return { ok: false, failure: 'stale_generation' }
    if (!match.grants.includes(input.capability)) return { ok: false, failure: 'capability_not_granted' }
    return { ok: true, binding: match }
  }

  /**
   * Revoke exactly the credential given, leaving any newer one for the same pod intact.
   *
   * Compare-and-delete rather than delete-by-pod: a same-pod renewal re-points the pod
   * index at the replacement before the superseded socket finishes closing, so revoking
   * "whatever this pod currently holds" from that late close would delete the credential
   * the live channel is using — renewal would appear to succeed and then silently die.
   */
  revokeIssued(credential: string): void {
    const binding = this.byCredential.get(credential)
    if (!binding) return
    this.byCredential.delete(credential)
    if (this.credentialByPod.get(binding.podUid) === credential) this.credentialByPod.delete(binding.podUid)
  }

  /** Drop every binding for a subject's pod, across its incarnations; a sibling session pod's stay. */
  revokeSubject(subject: string): void {
    for (const [credential, binding] of [...this.byCredential]) {
      if (spawnSubject(binding) !== subject) continue
      this.byCredential.delete(credential)
      this.credentialByPod.delete(binding.podUid)
    }
  }

  size(): number {
    return this.byCredential.size
  }

  private find(credential: string): Binding | undefined {
    // Constant-time over the whole set: a plain Map.get would leak whether a guessed
    // credential shares a prefix with a live one through timing.
    for (const [known, binding] of this.byCredential) {
      if (sameSecret(known, credential)) return binding
    }
    return undefined
  }

  private revokeCredential(credential: string): void {
    this.revokeIssued(credential)
  }
}
