import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { prepareRuntimeLaunch, type PreparedRuntimeLaunch } from '../acp/runtime-launch.js'
import type { SandboxMechanism } from '../acp/sandbox.js'
import {
  describeRuntime,
  runtimeMemoryCapabilities,
  runtimeMemoryDisabledEnv,
  runtimeMemoryPolicyId
} from '../agents/runtime-memory.js'
import { MemoryProviderUnavailableError, type MemoryProviderKind } from '../agents/memory-provider.js'
import type { RuntimeDef } from '../config/config-schema.js'

export interface ComposedRuntimeLaunch {
  runtime: RuntimeDef
  launch: PreparedRuntimeLaunch
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertGeneratedDestination(root: string, destination: string): void {
  const trustedRoot = resolve(root)
  const target = resolve(destination)
  const rel = relative(trustedRoot, target)
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`generated runtime policy escapes the agent root: ${destination}`)
  }

  let current = trustedRoot
  for (const part of rel.split(sep).filter(Boolean)) {
    current = join(current, part)
    if (!existsSync(current)) break
    if (lstatSync(current).isSymbolicLink()) {
      throw new Error(`generated runtime policy destination contains a symlink: ${current}`)
    }
  }
}

function atomicPrivateWrite(root: string, destination: string, content: string): void {
  assertGeneratedDestination(root, destination)
  const parent = dirname(destination)
  mkdirSync(parent, { recursive: true, mode: 0o700 })
  assertGeneratedDestination(root, destination)

  const temp = join(parent, `.${randomUUID()}.tmp`)
  try {
    writeFileSync(temp, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    chmodSync(temp, 0o600)
    renameSync(temp, destination)
    chmodSync(destination, 0o600)
  } catch (error) {
    try {
      unlinkSync(temp)
    } catch {
      // The temp may not have been created or may already have been renamed.
    }
    throw error
  }
}

function memoryUnavailable(runtime: RuntimeDef, runtimeId: string, provider: MemoryProviderKind): never {
  throw new MemoryProviderUnavailableError(
    `${provider} memory is not supported for this runtime (off-switch unverified): ${describeRuntime(runtime, runtimeId)}; use managed or register a verified runtime-memory policy`
  )
}

function sanitizeHermesConfig(scopeDir: string, launch: PreparedRuntimeLaunch): void {
  const hermesHome = launch.env.HERMES_HOME
  if (!hermesHome) throw new Error('private Hermes launch did not produce HERMES_HOME')
  const path = join(hermesHome, 'config.yaml')
  assertGeneratedDestination(scopeDir, path)

  let config: Record<string, unknown> = {}
  if (existsSync(path)) {
    const parsed = parseYaml(readFileSync(path, 'utf8')) as unknown
    if (parsed !== null && !isObject(parsed)) throw new Error('Hermes config.yaml must contain a YAML object')
    config = parsed ?? {}
  }
  if (config.memory !== undefined && !isObject(config.memory)) {
    throw new Error('Hermes config.yaml memory must contain a YAML object')
  }
  config.memory = {
    ...(config.memory ?? {}),
    memory_enabled: false,
    user_profile_enabled: false,
    provider: ''
  }
  atomicPrivateWrite(scopeDir, path, stringifyYaml(config))
}

function writeOmpOverlay(scopeDir: string): string {
  const path = join(resolve(scopeDir), '.agentconnect', 'runtime-policy', 'omp-memory-off.yml')
  atomicPrivateWrite(scopeDir, path, stringifyYaml({ memory: { backend: 'off' } }))
  return path
}

/** Compose the complete per-runtime memory launch mutation. Runtime/home env is
 * prepared first; verified memory env/argv/generated-file controls are applied
 * last so operator config cannot silently re-enable persistent harness memory. */
export function composeRuntimeLaunch(opts: {
  runtimeId: string
  runtime: RuntimeDef
  provider: MemoryProviderKind
  scopeDir: string
  cwd: string
  explicitEnv?: Record<string, string>
  stateSourceEnv?: NodeJS.ProcessEnv
  hostEnv?: NodeJS.ProcessEnv
  isolateHome?: boolean
  runInSandbox: boolean
  sandboxMechanism?: SandboxMechanism
  mcpSocketPath?: string
  maskedReadRoots?: string[]
}): ComposedRuntimeLaunch {
  const policyId = runtimeMemoryPolicyId(opts.runtime, opts.runtimeId)
  const capabilities = runtimeMemoryCapabilities(opts.runtime, opts.runtimeId)

  if (opts.provider === 'native' && !capabilities.native) {
    memoryUnavailable(opts.runtime, opts.runtimeId, opts.provider)
  }
  if ((opts.provider === 'none' || opts.provider === 'external') && !capabilities.none) {
    memoryUnavailable(opts.runtime, opts.runtimeId, opts.provider)
  }

  const protectedMemory = opts.provider !== 'native'
  const launch = prepareRuntimeLaunch({
    runtimeId: opts.runtimeId,
    scopeDir: opts.scopeDir,
    cwd: opts.cwd,
    runInSandbox: opts.runInSandbox,
    isolateHome: opts.isolateHome || (protectedMemory && policyId === 'hermes-agent'),
    explicitEnv: opts.explicitEnv,
    stateSourceEnv: opts.stateSourceEnv,
    hostEnv: opts.hostEnv,
    sandboxMechanism: opts.sandboxMechanism,
    mcpSocketPath: opts.mcpSocketPath,
    maskedReadRoots: opts.maskedReadRoots
  })
  const composed: RuntimeDef = { ...opts.runtime, args: [...opts.runtime.args], env: [...opts.runtime.env] }

  if (!protectedMemory) return { runtime: composed, launch }

  try {
    const effectiveEnv: NodeJS.ProcessEnv = { ...(opts.hostEnv ?? process.env), ...launch.env }
    Object.assign(launch.env, runtimeMemoryDisabledEnv(opts.runtime, effectiveEnv, opts.runtimeId) ?? {})

    if (policyId === 'hermes-agent') sanitizeHermesConfig(opts.scopeDir, launch)
    if (policyId === 'open-interpreter') composed.args.push('--disable', 'memories')
    if (policyId === 'omp') composed.args.push('--config', writeOmpOverlay(opts.scopeDir))
  } catch (error) {
    if (error instanceof MemoryProviderUnavailableError) throw error
    throw new MemoryProviderUnavailableError(error instanceof Error ? error.message : String(error))
  }

  return { runtime: composed, launch }
}
