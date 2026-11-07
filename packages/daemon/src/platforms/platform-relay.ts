// A platform module's way to a provider through the relay, for credentials the daemon never holds (`rd/platform/request`).
import type { RdPlatformReply, RdPlatformRequest } from '@agentconnect.md/protocol'

/** No relay could take the request, so nothing reached the provider and it may be sent again. */
export class PlatformRelayUnsent extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PlatformRelayUnsent'
  }
}

export interface PlatformRelay {
  /** Rejects with {@link PlatformRelayUnsent} when no relay took it; any other rejection may mean the provider call happened. */
  request(req: RdPlatformRequest): Promise<RdPlatformReply>
}
