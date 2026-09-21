import type { LaunchTimer } from '../metrics/cluster-metrics.js'
import type { PeerProof } from '../shim/binding.js'
import type { Launch } from './launch-registry.js'

/** What the dialed peer must prove: the name its shim has to answer to, and how that name is proved — a pod's TokenReview identity, or the TLS-PSK pipe an executor admitted this dial on (session-executors.md §6). */
export interface PeerExpectation {
  name: string
  proof: PeerProof
}

/** Where a launch's shim can be dialed right now, and who must answer there. */
export interface ShimEndpoint {
  address: string
  peer: PeerExpectation
}

/** Obtains a reachable shim endpoint for a launch; dialing, binding and driving it are the generic remainder. */
export interface ShimEndpointProvider<L extends Launch = Launch> {
  /** Wake the launch's sandbox if it sleeps and wait until its shim is dialable, marking its own timer stages. */
  resolve(launch: L, timer?: LaunchTimer): Promise<ShimEndpoint>
  /** Hold the launch's sandbox against an idle suspension until the matching `release`. */
  retain(launch: L): void
  release(launch: L): void
}

/** A launch stage that ran out of time — typed, because a missed target and a broken backend are different operational stories. */
export class LaunchTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LaunchTimeoutError'
  }
}
