// The agent daemon's side of the Computer data plane (computer-use.md §3.7, §5.2): MCP to a desktop daemon through a relay.
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import {
  relayComputerMcpUrl,
  type ComputerChannelGrantRequest,
  type ComputerChannelGrantResult,
  type ComputerRelayEntry
} from '@agentconnect.md/protocol'

/** The Control Plane's grant: the daemon's CP client answers it over `computer-channel/grant`. */
export interface ComputerGrantSource {
  computerChannelGrant(payload: ComputerChannelGrantRequest, orgId?: string): Promise<ComputerChannelGrantResult>
}

/** One agent session's target Computer. */
export interface ComputerTarget extends ComputerChannelGrantRequest {
  orgId?: string
}

/** The CP refused a token, or no relay holds the Computer: a definite failure, nothing was sent to the desktop. */
export class ComputerChannelError extends Error {
  constructor(
    readonly code: 'denied' | 'unavailable' | 'not_attached',
    message: string
  ) {
    super(message)
    this.name = 'ComputerChannelError'
  }
}

type Granted = Extract<ComputerChannelGrantResult, { granted: true }>

/** Renew a token this long before it expires, so a call never leaves with one about to lapse. */
const RENEW_BEFORE_MS = 30_000

// Failures where the request provably never reached a relay, so another relay may take it without replaying input.
const UNSENT_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH'])

function unsent(error: unknown): boolean {
  const cause = (error as { cause?: { code?: string } }).cause
  return typeof cause?.code === 'string' && UNSENT_CODES.has(cause.code)
}

async function notAttached(res: Response): Promise<boolean> {
  if (res.status !== 503) return false
  const body = (await res
    .clone()
    .json()
    .catch(() => undefined)) as { error?: string } | undefined
  return body?.error === 'computer_not_attached'
}

export interface ComputerChannelOptions {
  grants: ComputerGrantSource
  target: ComputerTarget
  fetch?: typeof fetch
  now?: () => number
}

/** One session's channel to one Computer: holds its token, renews it, and picks a relay that has the desktop attached. */
export class ComputerChannel {
  private granted: Granted | undefined
  private granting: Promise<Granted> | undefined
  // The relay that last answered, tried first next time.
  private preferred: string | undefined
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number

  constructor(private readonly options: ComputerChannelOptions) {
    this.fetchImpl = options.fetch ?? fetch
    this.now = options.now ?? Date.now
  }

  /** The current grant, renewed when it is about to expire; throws a {@link ComputerChannelError} on refusal. */
  async grant(force = false): Promise<Granted> {
    const held = this.granted
    if (!force && held && Date.parse(held.expiresAt) - this.now() > RENEW_BEFORE_MS) return held
    this.granting ??= this.request().finally(() => (this.granting = undefined))
    return this.granting
  }

  private async request(): Promise<Granted> {
    const { orgId, ...payload } = this.options.target
    const result = await this.options.grants.computerChannelGrant(payload, orgId)
    if (!result.granted) {
      this.granted = undefined
      throw new ComputerChannelError(result.code, result.message)
    }
    this.granted = result
    return result
  }

  private ordered(relays: ComputerRelayEntry[]): ComputerRelayEntry[] {
    const first = relays.find((relay) => relay.relayId === this.preferred)
    return first ? [first, ...relays.filter((relay) => relay !== first)] : relays
  }

  /** A `fetch` for the MCP transport: it ignores the url it is given and sends to the Computer through a relay. */
  readonly fetch: typeof fetch = async (_input, init) => {
    // No standalone SSE stream through a buffered relay: answer the client's GET here instead of holding a relay slot.
    if ((init?.method ?? 'GET').toUpperCase() === 'GET') {
      return new Response(null, { status: 405, headers: { allow: 'POST, DELETE' } })
    }
    let grant = await this.grant()
    let renewed = false
    for (;;) {
      let refused: Response | undefined
      for (const relay of this.ordered(grant.relays)) {
        const headers = new Headers(init?.headers)
        headers.set('authorization', `Bearer ${grant.token}`)
        let res: Response
        try {
          res = await this.fetchImpl(relayComputerMcpUrl(relay.url, this.options.target.computerId), {
            ...init,
            headers
          })
        } catch (error) {
          if (unsent(error)) continue
          throw error
        }
        if (await notAttached(res)) continue
        // A token the desktop no longer accepts (a key rotated early, a clock jump): ask the CP once more.
        if (res.status === 401 && !renewed) {
          refused = res
          break
        }
        this.preferred = relay.relayId
        return res
      }
      if (!refused) {
        throw new ComputerChannelError('not_attached', 'no relay has this computer attached; it may be offline')
      }
      renewed = true
      grant = await this.grant(true)
    }
  }
}

export interface ComputerMcpConnection {
  client: Client
  channel: ComputerChannel
  close(): Promise<void>
}

/** Connect an MCP client to a Computer's `/mcp` for one agent session, through the relays the CP named. */
export async function connectComputerMcp(options: ComputerChannelOptions): Promise<ComputerMcpConnection> {
  const channel = new ComputerChannel(options)
  const grant = await channel.grant()
  const first = grant.relays[0]
  if (!first) throw new ComputerChannelError('not_attached', 'this install has no relay to reach the computer through')
  const transport = new StreamableHTTPClientTransport(
    new URL(relayComputerMcpUrl(first.url, options.target.computerId)),
    {
      fetch: channel.fetch,
      reconnectionOptions: {
        initialReconnectionDelay: 100,
        maxReconnectionDelay: 1_000,
        reconnectionDelayGrowFactor: 2,
        maxRetries: 0
      }
    }
  )
  const client = new Client({ name: 'agentconnect-daemon-computer', version: '1.0.0' }, { capabilities: {} })
  await client.connect(transport)
  return { client, channel, close: () => client.close() }
}
