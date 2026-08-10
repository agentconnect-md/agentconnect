import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { ShimCapability } from './protocol.js'

/** What the daemon knows about a sandbox it launched, before any shim dials in. */
export interface SpawnRecord {
  agentId: string
  /** Sandbox object UID — from the Sandbox's own `metadata.uid`; the claim has none. */
  sandboxUid: string
  /** Monotonic per-agent counter, incremented on every launch of a new pod. */
  generation: number
  /** Capabilities this launch may exercise, decided by the daemon at spawn time. */
  grants: ShimCapability[]
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
  /** Credential per pod UID, so re-binding the same pod replaces rather than stacks. */
  private readonly credentialByPod = new Map<string, string>()

  constructor(
    private readonly now: () => number,
    private readonly ttlMs: number
  ) {}

  /**
   * Issue a credential for a pod that proved its identity and matched a spawn record.
   * The credential is the only thing the shim ever holds: it is short-lived, bound to
   * this pod and generation, and re-obtained by re-handshaking, so the shim never
   * carries a long-lived org credential.
   */
  bind(record: SpawnRecord, pod: { name: string; uid: string }): { credential: string; binding: Binding } {
    const previous = this.credentialByPod.get(pod.uid)
    if (previous) this.byCredential.delete(previous)
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
    return { credential, binding }
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

  /** Drop a pod's binding — its sandbox went away, or the agent was deleted. */
  revokePod(podUid: string): void {
    const credential = this.credentialByPod.get(podUid)
    if (credential) this.byCredential.delete(credential)
    this.credentialByPod.delete(podUid)
  }

  /** Drop every binding for an agent, across pod incarnations. */
  revokeAgent(agentId: string): void {
    for (const [credential, binding] of [...this.byCredential]) {
      if (binding.agentId !== agentId) continue
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
    const binding = this.byCredential.get(credential)
    this.byCredential.delete(credential)
    if (binding) this.credentialByPod.delete(binding.podUid)
  }
}
