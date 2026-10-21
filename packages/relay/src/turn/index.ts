// The relay's TURN service from its config: the allocation engine, its listeners, and the secret the CP hands over.
import { createHash } from 'node:crypto'
import type { RelayConfig } from '../config.js'
import type { Logger } from '../log.js'
import { startTurnListeners, type TurnListeners } from './listeners.js'
import { createTurnMetrics } from './metrics.js'
import { TurnServer } from './server.js'
import { meteredTurnMetrics, TurnUsageMeter, type TurnUsageReport } from './usage.js'

export interface RelayTurn {
  urls: string[]
  onSecret(secret: string): void
  /** Bytes relayed per Computer since the last call, in reports of at most `max` Computers. */
  drainUsage(max: number): TurnUsageReport[]
  /** Put back a report that could not be sent. */
  restoreUsage(report: TurnUsageReport): void
  close(): Promise<void>
}

/** A stable per-instance relayed address in 198.18.0.0/15 (RFC 2544), so two relays' allocations never alias. */
export function defaultRelayedAddress(relayName: string): string {
  const n = createHash('sha256').update(relayName).digest().readUInt32BE(0) & 0x1ffff
  // Keep the last octet off 0 and 255, which some stacks treat as network or broadcast addresses.
  const last = Math.min(254, Math.max(1, n & 0xff))
  return `198.${18 + (n >> 16)}.${(n >> 8) & 0xff}.${last}`
}

/** Starts TURN when RELAY_TURN_PORT is set; bound before registering, so the CP never advertises one that cannot answer. */
export async function startRelayTurn(config: RelayConfig, log: Logger): Promise<RelayTurn | undefined> {
  if (config.RELAY_TURN_PORT === undefined) return undefined
  let secret: string | undefined
  const usage = new TurnUsageMeter()
  const metrics = meteredTurnMetrics(createTurnMetrics(), usage)
  const turn = new TurnServer({
    realm: config.RELAY_TURN_REALM,
    relayedAddress: config.RELAY_TURN_RELAYED_ADDRESS ?? defaultRelayedAddress(config.RELAY_NAME),
    secret: () => secret,
    limits: {
      maxAllocations: config.RELAY_TURN_MAX_ALLOCATIONS,
      maxAllocationsPerUser: config.RELAY_TURN_MAX_ALLOCATIONS_PER_USER,
      maxBitsPerSecond: config.RELAY_TURN_MAX_BPS,
      idleTimeoutMs: config.RELAY_TURN_IDLE_TIMEOUT_SEC * 1000
    },
    log,
    metrics
  })
  const listeners: TurnListeners = await startTurnListeners({
    turn,
    host: config.RELAY_TURN_HOST,
    port: config.RELAY_TURN_PORT,
    ...(config.RELAY_TURN_TLS_PORT && config.RELAY_TURN_TLS_CERT_FILE && config.RELAY_TURN_TLS_KEY_FILE
      ? {
          tls: {
            port: config.RELAY_TURN_TLS_PORT,
            certFile: config.RELAY_TURN_TLS_CERT_FILE,
            keyFile: config.RELAY_TURN_TLS_KEY_FILE
          }
        }
      : {}),
    maxConnections: config.RELAY_TURN_MAX_ALLOCATIONS * 2,
    log,
    metrics
  })
  turn.start()
  return {
    urls: config.RELAY_TURN_URLS,
    onSecret: (next) => {
      secret = next
    },
    drainUsage: (max) => usage.drain(max),
    restoreUsage: (report) => usage.restore(report),
    close: async () => {
      turn.close()
      await listeners.close()
    }
  }
}
