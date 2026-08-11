import { existsSync, readFileSync } from 'node:fs'
import type { AnyFrame, AuthOk, BootstrapLifecycle } from '@agentconnect.md/protocol'
import {
  buildEnvelope,
  CP_SUBPROTOCOL,
  CP_WS_PATH,
  DAEMON_BOOTSTRAP_PROTOCOL_VERSION,
  decodeEnvelope,
  RESERVED_RESTART_CODE
} from '@agentconnect.md/protocol'
import { ClientTransport, ReqRep, systemClock, type Transport } from '@agentconnect.md/connection'
import type { FlatOverrides } from './config/load-config.js'
import { configPath, resolveRoot } from './paths.js'
import { DAEMON_VERSION } from './version.js'
import { readCliEntry, runCliUpgrade, type UpgradeLog } from './lifecycle/cli-upgrade.js'

const BOOTSTRAP_TIMEOUT_MS = 5_000
export const BOOTSTRAP_RESTART_CODE = RESERVED_RESTART_CODE

export interface BootstrapUpgradeOpts {
  root?: string
  configPath?: string
  supervisor?: string
  overrides?: FlatOverrides
}

interface BootstrapControlPlane {
  url: string
  key: string
  daemonId?: string
}

export interface BootstrapUpgradeDeps {
  connect: (url: string) => Promise<Transport>
  install: (cliEntry: string, targetVersion: string, root: string, log: UpgradeLog) => Promise<boolean>
  log: UpgradeLog
}

/** Read only CP bootstrap fields; full validation remains in the daemon. */
export function bootstrapControlPlane(opts: BootstrapUpgradeOpts): BootstrapControlPlane | undefined {
  const overrides = opts.overrides ?? {}
  if (overrides.noCp) return undefined
  const root = resolveRoot(opts.root)
  const file = opts.configPath ?? configPath(root)
  let raw: Record<string, unknown> = {}
  try {
    if (existsSync(file)) raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  } catch {
    return undefined
  }
  const hasStoredControlPlane = typeof raw.controlPlane === 'object' && raw.controlPlane !== null
  const stored = hasStoredControlPlane ? (raw.controlPlane as Record<string, unknown>) : {}
  const enabled = overrides.apiUrl || overrides.apiKey ? true : hasStoredControlPlane && stored.enabled !== false
  const url = overrides.apiUrl ?? (typeof stored.url === 'string' ? stored.url : undefined)
  const key = overrides.apiKey ?? (typeof stored.key === 'string' ? stored.key : undefined)
  const daemonId = overrides.daemonId ?? (typeof raw.daemonId === 'string' ? raw.daemonId : undefined)
  if (!enabled || !url || !key) return undefined
  return { url, key, ...(daemonId ? { daemonId } : {}) }
}

async function reportResult(
  transport: Transport,
  correlator: ReqRep<AnyFrame>,
  lifecycle: BootstrapLifecycle,
  status: 'installed' | 'failed',
  reason?: string
): Promise<void> {
  const result = buildEnvelope('daemon/bootstrap/result', {
    operationId: lifecycle.operationId,
    status,
    ...(reason ? { reason: reason.slice(0, 500) } : {})
  })
  const reply = await correlator.request(result, (encoded) => transport.send(encoded), {
    maxTries: 1,
    ackTimeoutMs: BOOTSTRAP_TIMEOUT_MS
  })
  if (reply.type !== 'ack' || !(reply.payload as { ok?: boolean }).ok) {
    throw new Error('control plane rejected the bootstrap result')
  }
}

/** Run the non-blocking auth-only recovery check before loading the full daemon. */
export async function runBootstrapUpgrade(
  opts: BootstrapUpgradeOpts,
  partial: Partial<BootstrapUpgradeDeps> = {}
): Promise<'continue' | 'restart'> {
  const cp = bootstrapControlPlane(opts)
  if (!cp || (opts.supervisor !== 'cli' && opts.supervisor !== 'service')) return 'continue'
  const root = resolveRoot(opts.root)
  const cliEntry = readCliEntry(root)
  if (!cliEntry) return 'continue'

  const deps: BootstrapUpgradeDeps = {
    connect: (url) =>
      ClientTransport.dial(url, {
        subprotocol: CP_SUBPROTOCOL,
        path: CP_WS_PATH,
        handshakeTimeoutMs: BOOTSTRAP_TIMEOUT_MS
      }),
    install: runCliUpgrade,
    log: { info: (message) => console.error(message), error: (message) => console.error(message) },
    ...partial
  }

  let transport: Transport | undefined
  const correlator = new ReqRep<AnyFrame>(systemClock, BOOTSTRAP_TIMEOUT_MS, 1)
  try {
    transport = await deps.connect(cp.url)
    transport.onMessage((text) => {
      const decoded = decodeEnvelope(text)
      if (decoded.ok && decoded.frame.corr) correlator.settle(decoded.frame)
    })
    transport.onClose(() => correlator.rejectAll(new Error('bootstrap connection closed')))
    const auth = buildEnvelope('auth', {
      apiKey: cp.key,
      ...(cp.daemonId ? { daemonId: cp.daemonId } : {}),
      agentVersion: DAEMON_VERSION,
      bootstrapProtocolVersion: DAEMON_BOOTSTRAP_PROTOCOL_VERSION
    })
    const reply = await correlator.request(auth, (encoded) => transport!.send(encoded), {
      maxTries: 1,
      ackTimeoutMs: BOOTSTRAP_TIMEOUT_MS
    })
    if (reply.type !== 'auth/ok') throw new Error(`expected auth/ok, got ${reply.type}`)
    const lifecycle = (reply.payload as AuthOk).lifecycle
    if (!lifecycle || lifecycle.action !== 'upgrade' || lifecycle.targetVersion === DAEMON_VERSION) return 'continue'

    const installed = await deps.install(cliEntry, lifecycle.targetVersion, root, deps.log)
    if (!installed) {
      await reportResult(transport, correlator, lifecycle, 'failed', `failed to install ${lifecycle.targetVersion}`)
      return 'continue'
    }
    await reportResult(transport, correlator, lifecycle, 'installed').catch((err) => {
      deps.log.error(`cp: could not confirm bootstrap installation: ${(err as Error).message}`)
    })
    return 'restart'
  } catch (err) {
    deps.log.info(`cp: bootstrap check skipped (${(err as Error).message})`)
    return 'continue'
  } finally {
    correlator.rejectAll(new Error('bootstrap complete'))
    transport?.close(1000, 'bootstrap complete')
  }
}
