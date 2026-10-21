// The pool members a ComputerPool sends desktop claim ops to: install-wide daemons connected here that serve them (computer-use.md §15.1).
import { COMPUTER_POOL_MEMBER_FEATURE, ComputerPoolOpResult, type ComputerPoolOp } from '@agentconnect.md/protocol'
import type { ComputerPoolMembers } from '../registry/computerPool.js'
import type { ConnectionRegistry, DaemonConnState } from '../ws/registry.js'

/** Claim ops wait at most this long for a member; a registration push waits on the pod and the exchange. */
export const COMPUTER_POOL_OP_TIMEOUT_MS = 60_000

export class ConnectedPoolMembers implements ComputerPoolMembers {
  private next = 0

  constructor(
    private readonly registry: Pick<ConnectionRegistry, 'reachableDaemons'>,
    private readonly log?: { warn(obj: unknown, msg?: string): void }
  ) {}

  private members(): DaemonConnState[] {
    return this.registry
      .reachableDaemons()
      .filter(
        (d) =>
          d.orgId === null &&
          d.state === 'READY' &&
          (d.capabilities?.features ?? []).includes(COMPUTER_POOL_MEMBER_FEATURE)
      )
  }

  available(): boolean {
    return this.members().length > 0
  }

  // One member per op, in turn, sent once: every op is idempotent, so a lost reply is retried on the next pass.
  async op(op: ComputerPoolOp): Promise<ComputerPoolOpResult | undefined> {
    const members = this.members()
    if (members.length === 0) return undefined
    const member = members[this.next++ % members.length]!
    try {
      const reply = await member.conn.request(
        'computer-pool/op',
        op,
        { epoch: member.sessionEpoch },
        { ackTimeoutMs: COMPUTER_POOL_OP_TIMEOUT_MS, maxTries: 1 }
      )
      return ComputerPoolOpResult.parse(reply)
    } catch (err) {
      this.log?.warn({ err, daemonId: member.daemonId, op: op.op }, 'computer-pool: member op failed')
      return undefined
    }
  }
}
