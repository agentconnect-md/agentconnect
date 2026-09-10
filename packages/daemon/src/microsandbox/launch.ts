import { existsSync, lstatSync, mkdirSync, realpathSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { hostKeyDirName, hostKeySessionKey, type HostKey } from '../acp/host-key.js'
import { sandboxBoundary } from '../acp/sandbox.js'
import { applyCodexPermissionProfile } from '../acp/codex-permission-profiles.js'
import type { RuntimeDef, SandboxMount } from '../config/config-schema.js'
import { GITCRED_SOCKET_ENV } from '../gitcred/env.js'
import { privateRuntimeHomeFor, runtimeGitMetadataRoots, type PreparedRuntimeLaunch } from '../launch/prepare.js'
import { nativeRuntimeMemorySpecFor } from '../memory/runtime/capabilities.js'
import {
  claudeProviderCredentialFiles,
  isClaudeRuntimeDef,
  prepareClaudeProtectedSettings
} from '../runtime-defs/claude-runtime.js'
import { runtimeExecutableHints } from '../runtime-defs/executable-hints.js'
import { canonicalPath, compactReadRoots, contains, normalizeSandboxMounts } from '../runtimes/read-roots.js'
import { prepareSharedRuntimeCredentials, sharedCredentialProfile } from '../runtimes/runtime-credentials.js'
import { prepareRuntimeHome, removeRuntimeHomeSeedFiles, runtimeHomeEnvironment } from '../runtimes/runtime-home.js'
import { SESSIONS_DIR } from '../workspace/session-layout.js'
import { MICROSANDBOX_SOCKET_BRIDGES, MICROSANDBOX_TUNNEL_PATHS } from './socket-bridge.js'
import { OVERLAY_BASE_ROOT, OVERLAY_STATE_ROOT } from './overlay.js'
import { prepareDeepSeekSecret, type MicrosandboxSecret } from './secrets.js'

const IMAGE_PATH = '/opt/agentconnect/pathbin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
const HOST_IPC_ENV = [
  'SSH_AUTH_SOCK',
  'SSH_AGENT_PID',
  'DBUS_SESSION_BUS_ADDRESS',
  'DBUS_SYSTEM_BUS_ADDRESS',
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'PULSE_SERVER',
  'PIPEWIRE_REMOTE',
  'GPG_AGENT_INFO',
  'GNOME_KEYRING_CONTROL',
  'SESSION_MANAGER',
  'TMUX',
  'VSCODE_IPC_HOOK_CLI',
  'NOTIFY_SOCKET',
  'TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE',
  'DOCKER_HOST',
  'CONTAINER_HOST',
  'BUILDKIT_HOST',
  'PODMAN_HOST'
]

export interface PrepareMicrosandboxLaunchOptions {
  runtimeId: string
  runtime?: RuntimeDef
  scopeDir: string
  cwd: string
  hostKey?: HostKey
  explicitEnv?: Record<string, string>
  stateSourceEnv?: NodeJS.ProcessEnv
  nativeMemory?: boolean
  trustedSessionDir?: string
  trustedWorkspaceWriteRoots?: string[]
  trustedRuntimeReadRoots?: string[]
  trustedPrimaryCheckout?: string
  allowModelToolUnixSockets?: boolean
  trustedMounts?: SandboxMount[]
  mounts: SandboxMount[]
}

export function prepareMicrosandboxLaunch(opts: PrepareMicrosandboxLaunchOptions): PreparedRuntimeLaunch & {
  microsandbox: { mounts: SandboxMount[]; workspaceRoot: string; secrets?: MicrosandboxSecret[] }
} {
  if (opts.runtime?.externalExecution) {
    throw new Error(`runtime "${opts.runtimeId}" executes outside the microsandbox VM`)
  }
  const scopeDir = realpathSync(resolve(opts.scopeDir))
  const hostEnv = opts.stateSourceEnv ?? process.env
  let runtimeHome = privateRuntimeHomeFor(scopeDir, opts.hostKey)
  if (opts.hostKey && hostKeySessionKey(opts.hostKey) !== undefined && runtimeHome === join(scopeDir, 'home')) {
    runtimeHome = join(scopeDir, 'runtime-homes', hostKeyDirName(opts.hostKey), 'home')
  }
  const sessionDir = opts.trustedSessionDir ? realpathSync(opts.trustedSessionDir) : undefined
  if (sessionDir) {
    const parts = relative(scopeDir, sessionDir).split(sep)
    if (parts.length !== 2 || parts[0] !== SESSIONS_DIR || !parts[1] || !statSync(sessionDir).isDirectory()) {
      throw new Error('microsandbox session directory must be one existing scopeDir/sessions/<leaf> directory')
    }
    runtimeHome = join(sessionDir, 'home')
  }
  const boundary = sandboxBoundary({ agentDir: scopeDir, cwd: opts.cwd, runtimeHome })
  if (sessionDir && !contains(sessionDir, boundary.writable[0]!)) {
    throw new Error('microsandbox cwd is outside its session directory')
  }
  const scopePath = (path: string): string =>
    sandboxBoundary({ agentDir: scopeDir, cwd: path, runtimeHome }).writable[0]!
  const writable = [
    ...boundary.writable,
    ...(sessionDir ? [sessionDir] : []),
    ...(opts.trustedWorkspaceWriteRoots ?? []).map(scopePath)
  ]
  const configDirs = [join(scopeDir, 'run', 'config-files'), join(scopeDir, '.agentconnect', 'runtime-policy')].map(
    scopePath
  )
  for (const path of [...writable, ...configDirs]) mkdirSync(path, { recursive: true, mode: 0o700 })

  const credentials = prepareSharedRuntimeCredentials({ runtimeId: opts.runtimeId, runtime: opts.runtime, hostEnv })
  const deepseek = prepareDeepSeekSecret(opts.runtimeId, opts.runtime, hostEnv, opts.explicitEnv)
  runtimeHome = prepareRuntimeHome(opts.runtimeId, scopeDir, hostEnv, runtimeHome, [
    ...(credentials?.seedExclusions ?? []),
    ...(deepseek?.seedExclusions ?? [])
  ])
  if (deepseek) removeRuntimeHomeSeedFiles(runtimeHome, deepseek.seedExclusions)
  credentials?.preparePrivateHome(runtimeHome)
  writable.push(...(credentials?.writablePaths ?? []))
  const readRoots = (opts.trustedRuntimeReadRoots ?? []).filter((path) => {
    if (!existsSync(path)) return false
    const stat = statSync(path)
    return stat.isFile() || stat.isDirectory()
  })
  const automaticSource = (path: string): string => {
    const source = realpathSync(path)
    if (contains(source, scopeDir) || (hostEnv.HOME && contains(source, resolve(hostEnv.HOME)))) {
      throw new Error(`microsandbox automatic mount would expose an entire agent or host HOME: ${source}`)
    }
    return source
  }
  const writeRoots = compactReadRoots(writable.map(automaticSource))
  const nativeMemory = opts.nativeMemory && nativeRuntimeMemorySpecFor(opts.runtime, opts.runtimeId)
  const memoryMounts: SandboxMount[] = []
  if (nativeMemory && !sessionDir && runtimeHome !== join(scopeDir, 'home')) {
    const source = scopePath(nativeMemory.readRoot(join(scopeDir, 'home')))
    const target = scopePath(nativeMemory.readRoot(runtimeHome))
    for (const path of [source, target]) mkdirSync(path, { recursive: true, mode: 0o700 })
    memoryMounts.push({ source, target, mode: 'writable' })
  }
  const automatic: SandboxMount[] = [
    ...compactReadRoots([...configDirs, ...readRoots].map(automaticSource))
      .filter((path) => !writeRoots.some((write) => contains(write, path)))
      .map((source) => ({ source, target: source, mode: 'readonly' as const })),
    ...writeRoots.map((source) => ({ source, target: source, mode: 'writable' as const })),
    ...normalizeSandboxMounts([...(opts.trustedMounts ?? []), ...memoryMounts], hostEnv, 'microsandbox').map(
      (mount) => ({
        ...mount,
        source: automaticSource(mount.source)
      })
    )
  ]
  const configured = normalizeSandboxMounts(opts.mounts, hostEnv, 'microsandbox', runtimeHome)
  const ownedTargets = [
    '/run',
    '/var/run',
    '/var/lib/docker',
    OVERLAY_BASE_ROOT,
    OVERLAY_STATE_ROOT,
    join(runtimeHome, '.run'),
    ...automatic.map((mount) => mount.target),
    ...MICROSANDBOX_SOCKET_BRIDGES.map((bridge) => bridge.path)
  ]
  for (const mount of configured) {
    const withinHome = mount.target !== runtimeHome && contains(runtimeHome, mount.target)
    if (
      ownedTargets.some(
        (target) =>
          contains(mount.target, target) ||
          (contains(target, mount.target) && !(withinHome && contains(target, runtimeHome)))
      )
    ) {
      throw new Error(`sandbox.mounts target overlaps an automatic microsandbox mount: ${mount.target}`)
    }
  }

  const env = { ...runtimeHomeEnvironment(opts.runtimeId, runtimeHome, opts.explicitEnv, hostEnv), ...credentials?.env }
  if (deepseek?.secret) {
    const secret = deepseek.secret
    for (const [name, value] of Object.entries(env))
      env[name] = value.replaceAll(secret.readValue(), secret.placeholder)
    env[secret.env] = secret.placeholder
    env.NODE_EXTRA_CA_CERTS = '/.msb/tls/ca.pem'
    env.SSL_CERT_FILE = env.REQUESTS_CA_BUNDLE = env.CURL_CA_BUNDLE = '/etc/ssl/certs/ca-certificates.crt'
  }
  for (const name of HOST_IPC_ENV) delete env[name]
  // Drop ambient Docker client settings, but keep explicit guest config, including materialized registry config.
  for (const name of [
    'TESTCONTAINERS_HOST_OVERRIDE',
    'DOCKER_CONTEXT',
    'DOCKER_CONFIG',
    'DOCKER_CERT_PATH',
    'DOCKER_TLS',
    'DOCKER_TLS_VERIFY'
  ]) {
    if (opts.explicitEnv?.[name] === undefined) delete env[name]
  }
  for (const { envVar } of opts.runtime ? runtimeExecutableHints(opts.runtime) : []) {
    if (opts.explicitEnv?.[envVar] === undefined) delete env[envVar]
  }
  env.PATH = opts.explicitEnv?.PATH ?? IMAGE_PATH
  env.TMPDIR = env.TMP = env.TEMP = '/tmp'
  env.CLAUDE_TMPDIR = env.CLAUDE_CODE_TMPDIR = '/tmp'
  env.XDG_RUNTIME_DIR = join(runtimeHome, '.run')
  if (existsSync(env.XDG_RUNTIME_DIR) && !lstatSync(env.XDG_RUNTIME_DIR).isDirectory()) {
    throw new Error('microsandbox private XDG runtime path must be a real directory')
  }
  mkdirSync(env.XDG_RUNTIME_DIR, { recursive: true, mode: 0o700 })
  env[GITCRED_SOCKET_ENV] = MICROSANDBOX_TUNNEL_PATHS.gitcred
  const mounts = [...automatic, ...configured]
  const deepseekSources = deepseek?.sources.map((path) => canonicalPath(path, hostEnv)) ?? []
  if (mounts.some(({ source }) => deepseekSources.some((path) => contains(source, path)))) {
    throw new Error('sandbox.mounts would expose a host DeepSeek credential file')
  }
  const credentialProfile = sharedCredentialProfile(opts.runtimeId, opts.runtime)
  const claudeRuntime = Boolean(opts.runtime && isClaudeRuntimeDef(opts.runtime))
  const claudeSettings = claudeRuntime ? prepareClaudeProtectedSettings(scopeDir, env) : undefined
  const privateStateTargets = deepseek
    ? deepseek.seedExclusions.map((path) => join(runtimeHome, path))
    : credentialProfile === 'codex'
      ? [join(runtimeHome, '.codex')]
      : claudeRuntime
        ? [join(runtimeHome, '.claude'), join(runtimeHome, '.claude.json')]
        : []
  const privateState = privateStateTargets.filter(existsSync).map((path) => realpathSync(path))
  const credentialSources = [...(credentials?.writablePaths ?? []), ...privateState].map((path) =>
    existsSync(path) ? realpathSync(path) : path
  )
  const providerFiles = claudeSettings ? claudeProviderCredentialFiles(env, opts.cwd).map(({ path }) => path) : []
  for (const { target } of configured) {
    if ([...privateStateTargets, ...providerFiles].some((path) => contains(path, target) || contains(target, path))) {
      throw new Error(`sandbox.mounts target overlaps protected runtime state: ${target}`)
    }
  }
  for (const path of providerFiles) {
    const mount = mounts
      .filter(({ target }) => contains(target, path))
      .sort((a, b) => b.target.length - a.target.length)[0]
    if (mount) credentialSources.push(join(mount.source, relative(mount.target, path)))
  }
  const protectedCredentialRoots = compactReadRoots([
    ...privateState,
    ...providerFiles,
    ...mounts.flatMap(({ source, target }) =>
      credentialSources.flatMap((path) =>
        contains(source, path) ? [join(target, relative(source, path))] : contains(path, source) ? [target] : []
      )
    )
  ])
  const sharedWriteRoots = configured
    .filter(
      ({ mode, target }) => mode !== 'readonly' && !protectedCredentialRoots.some((root) => contains(root, target))
    )
    .map(({ target }) => target)
  const gitMetadataWriteRoots = runtimeGitMetadataRoots(scopeDir, opts.trustedPrimaryCheckout, sessionDir).filter(
    (path) => mounts.some(({ target, mode }) => mode !== 'readonly' && contains(target, path))
  )
  if (credentialProfile === 'codex') {
    applyCodexPermissionProfile(env, {
      protectedRoots: protectedCredentialRoots,
      ...(sessionDir
        ? { sessionGitMetadataRoots: gitMetadataWriteRoots }
        : { writableGitMetadataRoots: gitMetadataWriteRoots }),
      ...(sessionDir || (opts.hostKey && hostKeySessionKey(opts.hostKey)) ? { sessionHomeRoot: runtimeHome } : {}),
      sharedWriteRoots,
      allowModelToolUnixSockets: opts.allowModelToolUnixSockets === true,
      disableUnifiedExec: true
    })
  }
  return {
    env,
    inheritProcessEnv: false,
    gitMetadataWriteRoots,
    runtimeHome,
    toolSandbox: {
      protectedCredentialRoots,
      ...(opts.allowModelToolUnixSockets ? { allowModelToolUnixSockets: true } : {}),
      ...(claudeSettings ? { claudeProtectedSettings: claudeSettings } : {}),
      ...(sharedWriteRoots.length > 0 ? { sharedWriteRoots } : {})
    },
    microsandbox: {
      mounts,
      workspaceRoot: scopeDir,
      ...(deepseek?.secret ? { secrets: [deepseek.secret] } : {})
    }
  }
}
