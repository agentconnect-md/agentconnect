import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { PodIdentityVerifier } from '../shim/connection.js'
import { SHIM_TOKEN_AUDIENCE } from '../shim/protocol.js'

/**
 * Proves which guest answered a dial, standing in for the cluster's TokenReview.
 *
 * The real proof is the transport, and it is stronger than the pod path's. A pod is reached over a
 * routable network by an IP the cluster reuses, which is why `cluster-spawn-and-shim.md` §3 refuses
 * to treat the dial target as identity. A guest is reached over a loopback port this daemon's own
 * hypervisor helper bound to one `VZVirtualMachine` it created, so nothing else can be on the other
 * end of it.
 *
 * The token therefore fences boots rather than authenticating strangers: a guest from a previous
 * incarnation, still holding a stale secret, must not bind as the current one. That is the same job
 * the generation counter does one layer up, checked here so a replaced VM cannot answer for its
 * successor.
 */
export class VmBootRegistry implements PodIdentityVerifier {
  private readonly issued = new Map<string, Buffer>()

  /** Mint this boot's secret. The caller writes it into the guest over a read-only share. */
  issue(vmName: string): string {
    const token = randomBytes(32).toString('hex')
    this.issued.set(vmName, Buffer.from(token, 'utf8'))
    return token
  }

  /** Retire a boot's secret, so a guest that outlives its launch cannot bind again. */
  revoke(vmName: string): void {
    this.issued.delete(vmName)
  }

  revokeAll(): void {
    this.issued.clear()
  }

  async reviewToken(
    token: string,
    audiences: string[]
  ): Promise<{ authenticated: boolean; podName?: string; podUid?: string; error?: string }> {
    if (!audiences.includes(SHIM_TOKEN_AUDIENCE)) {
      return { authenticated: false, error: 'unexpected audience' }
    }
    const candidate = Buffer.from(token, 'utf8')
    for (const [vmName, secret] of this.issued) {
      if (secret.length === candidate.length && timingSafeEqual(secret, candidate)) {
        // The VM name is both identity and incarnation: a new boot gets a new name, so a stale
        // guest can never present the name its successor is bound under.
        return { authenticated: true, podName: vmName, podUid: vmName }
      }
    }
    return { authenticated: false, error: 'unrecognized boot secret' }
  }
}

/** One boot's identity. The generation is in the name so a replaced guest is a different peer. */
export function vmNameFor(agentId: string, generation: number): string {
  return `vm-${agentId}-${generation}`
}
