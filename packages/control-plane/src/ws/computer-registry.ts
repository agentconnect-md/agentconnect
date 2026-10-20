// The in-memory index of live Computer channels, so a revoke, delete or policy change reaches the desktop at once.
import type { ComputerPolicy, ComputerRevoke } from '@agentconnect.md/protocol'

/** The slice of a live Computer connection the registry drives; no `ws` knowledge. */
export interface ComputerChannel {
  readonly computerId: string
  readonly orgId: string
  readonly ownerUserId: string
  pushPolicy(policy: ComputerPolicy): void
  revoke(reason: ComputerRevoke['reason']): void
  close(code: number, reason: string): void
}

/** What the REST side may do to live channels. */
export interface ComputerChannelControl {
  revoke(computerId: string, reason: ComputerRevoke['reason']): void
  revokeOwner(orgId: string, ownerUserId: string): void
  pushPolicy(computerId: string, policy: ComputerPolicy): void
}

export class ComputerChannelRegistry implements ComputerChannelControl {
  private readonly byComputer = new Map<string, ComputerChannel>()

  /** Register `ch`, superseding a stale socket for the same Computer. */
  add(ch: ComputerChannel): void {
    const prev = this.byComputer.get(ch.computerId)
    this.byComputer.set(ch.computerId, ch)
    if (prev && prev !== ch) prev.close(1012, 'superseded by a newer connection for this computer')
  }

  get(computerId: string): ComputerChannel | undefined {
    return this.byComputer.get(computerId)
  }

  /** Remove `ch` only while it is still the registered one; true when it was. */
  remove(ch: ComputerChannel): boolean {
    if (this.byComputer.get(ch.computerId) !== ch) return false
    this.byComputer.delete(ch.computerId)
    return true
  }

  revoke(computerId: string, reason: ComputerRevoke['reason']): void {
    this.byComputer.get(computerId)?.revoke(reason)
  }

  revokeOwner(orgId: string, ownerUserId: string): void {
    for (const ch of [...this.byComputer.values()]) {
      if (ch.orgId === orgId && ch.ownerUserId === ownerUserId) ch.revoke('owner_removed')
    }
  }

  pushPolicy(computerId: string, policy: ComputerPolicy): void {
    this.byComputer.get(computerId)?.pushPolicy(policy)
  }

  get size(): number {
    return this.byComputer.size
  }
}
