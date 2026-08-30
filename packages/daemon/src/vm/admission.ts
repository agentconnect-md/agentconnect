import { availableParallelism } from 'node:os'

/** Raised when a boot would put the host past what it can actually run. */
export class VmBudgetExceededError extends Error {}

export interface VmBudgetOptions {
  hostCores?: number
  /**
   * Ceiling on the SUM of guest vCPUs, not on VM count.
   *
   * Measured, not guessed: past roughly 2x host cores in summed vCPUs, guests stop booting and
   * start dying with `Attempted to kill init! exitcode=0x0000000b` — a SIGSEGV in PID 1 — while
   * host memory is still a third free. Ten 2-vCPU guests are fine on an 8 core host, twelve are
   * not, and the same twelve are fine at 1 vCPU each. So this is admission, not tuning: refusing a
   * launch is the only outcome better than booting a guest that panics.
   */
  maxTotalVcpus?: number
  /** Second, coarser ceiling: each guest also costs memory and a helper process. */
  maxConcurrentVms?: number
  /** vCPUs per guest. One is the right default — more guests at 1 vCPU beat fewer at 2 for work
   *  that waits on a network, which is most agent work. */
  cpuPerVm?: number
}

export interface VmBudget {
  hostCores: number
  maxTotalVcpus: number
  maxConcurrentVms: number
  cpuPerVm: number
}

export function resolveVmBudget(options: VmBudgetOptions = {}): VmBudget {
  const hostCores = Math.max(1, options.hostCores ?? availableParallelism())
  const cpuPerVm = Math.max(1, options.cpuPerVm ?? 1)
  return {
    hostCores,
    cpuPerVm,
    maxTotalVcpus: Math.max(cpuPerVm, options.maxTotalVcpus ?? hostCores * 2),
    maxConcurrentVms: Math.max(1, options.maxConcurrentVms ?? Math.floor((hostCores * 2) / cpuPerVm))
  }
}

/**
 * Decides whether another guest can boot on this host.
 *
 * Held here rather than in the driver because it is a property of the HOST, shared by every agent,
 * while the driver reasons about one launch at a time. A refusal is explicit and says what the
 * limit was, because the alternative an operator would otherwise see is a guest whose init
 * segfaults for no visible reason.
 */
export class VmAdmission {
  private readonly held = new Set<string>()

  constructor(readonly budget: VmBudget) {}

  /** Idempotent: an agent that already holds a slot is not charged twice. */
  acquire(agentId: string): void {
    if (this.held.has(agentId)) return
    const refusal = this.refuse()
    if (refusal) throw new VmBudgetExceededError(refusal)
    this.held.add(agentId)
  }

  release(agentId: string): void {
    this.held.delete(agentId)
  }

  admitted(): string[] {
    return [...this.held]
  }

  get totalVcpus(): number {
    return this.held.size * this.budget.cpuPerVm
  }

  private refuse(): string | undefined {
    const { maxConcurrentVms, maxTotalVcpus, cpuPerVm, hostCores } = this.budget
    // vCPUs first: the two ceilings coincide under the defaults, and this is the one that explains
    // itself. The count ceiling only ever speaks when an operator raised this one past it.
    const wanted = this.totalVcpus + cpuPerVm
    if (wanted > maxTotalVcpus) {
      return (
        `booting another ${cpuPerVm}-vCPU guest would ask for ${wanted} guest vCPUs on ${hostCores} host ` +
        `cores, past the ${maxTotalVcpus} this host admits — guests panic in PID 1 above roughly 2x cores`
      )
    }
    if (this.held.size + 1 > maxConcurrentVms) {
      return `this host already runs ${this.held.size} agent VMs, its limit (maxConcurrentVms)`
    }
    return undefined
  }
}
