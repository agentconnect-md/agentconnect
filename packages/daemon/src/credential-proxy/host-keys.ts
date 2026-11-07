// The host's own provider API keys an srt session would otherwise read (github-app-git-credentials.md, Provider keys): each its own slot, resolved by reading the key again where this machine keeps it.
import { existsSync } from 'node:fs'
import type { RuntimeDef } from '../config/config-schema.js'
import {
  ambientCredentialRuntime,
  microsandboxPlaceholder,
  prepareAmbientCredentials,
  type MicrosandboxCredentials,
  type SecretBinding
} from '../microsandbox/secrets.js'
import { openCodeAuthExportAsync } from '../runtimes/opencode-host-keys.js'
import { sameSlotOrigin, type ProviderSlot } from './provider-route.js'

/** One host key behind the proxy: its slot, and how the daemon reads the key again. */
export interface HostKeySlot {
  slot: ProviderSlot
  read: () => Promise<string>
}

/** A launch's host keys behind placeholders, or why it keeps them as they are. */
export type SealedHostKeys = { credentials: MicrosandboxCredentials; slots: HostKeySlot[] } | { kept: string }

export interface HostKeySource {
  runtimeId: string
  runtime: RuntimeDef | undefined
  /** This machine's environment, read again on each resolution. */
  hostEnv: NodeJS.ProcessEnv
  /** The launch's runtime-definition and agent env, which name endpoints and may carry the key. */
  explicitEnv: Record<string, string>
  /** Test seam: a sign-in file is projected into the private HOME only on Linux. */
  platform?: NodeJS.Platform
}

/** The slot a host key goes through: `host:<runtime>:<variable>` at the one HTTPS host it reaches; undefined for any other binding. */
export function hostKeySlot(runtime: string, binding: SecretBinding): ProviderSlot | undefined {
  if (binding.hosts.length !== 1) return undefined
  const host = binding.hosts[0]!
  return {
    id: `host:${runtime}:${binding.env}`,
    provider: binding.provider,
    host,
    port: 443,
    saas: host === binding.defaultHost
  }
}

/** Run the runtime's preparers with the proxy's placeholders; undefined when it has no host key, `kept` when one cannot go through the proxy. */
export function sealHostProviderKeys(
  source: HostKeySource,
  seal: (slot: ProviderSlot) => string
): SealedHostKeys | undefined {
  const runtime = ambientCredentialRuntime(source.runtimeId, source.runtime)
  if (!runtime) return undefined
  const slots = new Map<string, ProviderSlot>()
  const unbound: string[] = []
  let credentials: MicrosandboxCredentials | undefined
  try {
    credentials = prepareAmbientCredentials(
      source.runtimeId,
      source.runtime,
      source.hostEnv,
      source.explicitEnv,
      (binding) => {
        const slot = hostKeySlot(runtime, binding)
        if (!slot) {
          unbound.push(binding.env)
          return microsandboxPlaceholder(binding)
        }
        slots.set(binding.env, slot)
        return seal(slot)
      }
    )
  } catch (error) {
    // The preparers' refusals name the file or setting, never a key.
    return { kept: error instanceof Error ? error.message : String(error) }
  }
  if (!credentials) return undefined
  if ((source.platform ?? process.platform) !== 'linux' && credentials.sources.some((path) => existsSync(path)))
    return { kept: 'projecting a sign-in file into the private HOME needs Linux' }
  if (unbound.length > 0) return { kept: `${unbound.join(', ')} reach no single HTTPS host the proxy recognizes` }
  return {
    credentials,
    slots: credentials.secrets.flatMap((secret) => {
      const slot = slots.get(secret.env)
      return slot ? [{ slot, read: () => readHostKey(source, runtime, slot, secret.env) }] : []
    })
  }
}

/** A slot's key as the host holds it now, awaiting any command that prints it; refused once it is gone or the runtime sends it to another origin. */
async function readHostKey(source: HostKeySource, runtime: string, slot: ProviderSlot, env: string): Promise<string> {
  const exported = runtime === 'opencode' ? await openCodeAuthExportAsync(source.hostEnv) : undefined
  const bindings = new Map<string, SecretBinding>()
  const credentials = prepareAmbientCredentials(
    source.runtimeId,
    source.runtime,
    source.hostEnv,
    source.explicitEnv,
    (binding) => {
      bindings.set(binding.env, binding)
      return microsandboxPlaceholder(binding)
    },
    exported === undefined ? {} : { openCodeAuthExport: () => exported }
  )
  const secret = credentials?.secrets.find((candidate) => candidate.env === env)
  const binding = bindings.get(env)
  if (!secret || !binding) throw new Error(`this machine no longer holds ${env}`)
  const current = hostKeySlot(runtime, binding)
  if (!current || !sameSlotOrigin(current, slot))
    throw new Error(`the endpoint for ${env} changed; a new session uses it`)
  return secret.readValue()
}
