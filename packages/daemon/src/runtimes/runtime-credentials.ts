import { timingSafeEqual } from 'node:crypto'
import {
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmdirSync,
  statSync,
  symlinkSync,
  unlinkSync
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import type { RuntimeDef } from '../config/config-schema.js'

export type SharedCredentialProfile = 'claude' | 'codex' | 'qoder' | 'qoder-cn'

export interface SharedRuntimeCredentialAccess {
  env: Record<string, string>
  /** Host paths that the trusted ACP runtime may update for login refresh. */
  writablePaths: string[]
  /** Private-HOME destinations that must no longer receive copy-once auth. */
  seedExclusions: string[]
  /** Finish migration/linking after the private runtime HOME exists. */
  preparePrivateHome: (runtimeHome: string) => void
}

function signature(runtime: RuntimeDef | undefined, pattern: RegExp): boolean {
  return runtime ? [runtime.command, ...runtime.args].some((part) => pattern.test(part.toLowerCase())) : false
}

/** Runtime identity is daemon/registry-owned; an agent can select an id but
 * cannot declare a credential profile or filesystem path. */
export function sharedCredentialProfile(runtimeId: string, runtime?: RuntimeDef): SharedCredentialProfile | undefined {
  if (runtimeId === 'claude-acp' || signature(runtime, /(?:^|[\\/@])claude(?:-[a-z-]+)?(?:@[^\\/]*)?$/)) {
    return 'claude'
  }
  if (runtimeId === 'codex-acp' || signature(runtime, /(?:^|[\\/])codex-acp(?:@[^\\/]*)?$/)) {
    return 'codex'
  }
  if (runtimeId === 'qoder-cli-cn' || signature(runtime, /(?:^|[\\/@])qoderclicn(?:@[^\\/]*)?$/)) {
    return 'qoder-cn'
  }
  if (runtimeId === 'qoder-cli' || signature(runtime, /(?:^|[\\/@])qodercli(?:@[^\\/]*)?$/)) {
    return 'qoder'
  }
  return undefined
}

function hostHome(env: NodeJS.ProcessEnv): string {
  return env.HOME || homedir()
}

function absoluteConfiguredPath(raw: string, env: NodeJS.ProcessEnv, label: string): string {
  const expanded = raw === '~' ? hostHome(env) : raw.startsWith('~/') ? join(hostHome(env), raw.slice(2)) : raw
  if (!isAbsolute(expanded) || resolve(expanded) === sep) throw new Error(`unsafe ${label}: ${raw}`)
  return resolve(expanded)
}

function ensureOwnedDirectory(path: string, label: string): string {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  const real = realpathSync(path)
  const stat = statSync(real)
  if (!stat.isDirectory()) throw new Error(`${label} is not a directory: ${path}`)
  const uid = process.getuid?.()
  if (uid !== undefined && stat.uid !== uid) throw new Error(`${label} is not owned by the daemon user: ${real}`)
  try {
    chmodSync(real, 0o700)
  } catch {
    // Linux is the only enabled shared-login target; keep tests portable.
  }
  return real
}

function existingFileTarget(path: string): string {
  const info = lstatSync(path)
  const target = info.isSymbolicLink() ? realpathSync(path) : path
  if (!statSync(target).isFile()) throw new Error(`credential path is not a regular file: ${path}`)
  return target
}

function lstatIfPresent(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

function secureCredentialFile(path: string): void {
  try {
    chmodSync(path, 0o600)
  } catch {
    // Best effort on non-POSIX test filesystems.
  }
}

function jsonObject(path: string): Record<string, unknown> {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Claude settings must contain a JSON object: ${path}`)
  }
  return parsed as Record<string, unknown>
}

function sameFileContents(a: string, b: string): boolean {
  const left = readFileSync(a)
  const right = readFileSync(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

function claudeCredentialGeneration(path: string): number | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
      claudeAiOauth?: { expiresAt?: unknown; expires_at?: unknown }
    }
    const value = parsed.claudeAiOauth?.expiresAt ?? parsed.claudeAiOauth?.expires_at
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string') {
      const numeric = Number(value)
      if (Number.isFinite(numeric)) return numeric
      const timestamp = Date.parse(value)
      return Number.isFinite(timestamp) ? timestamp : undefined
    }
    return undefined
  } catch {
    return undefined
  }
}

function prepareClaudeCredentials(env: NodeJS.ProcessEnv): SharedRuntimeCredentialAccess {
  const configured = env.CLAUDE_CONFIG_DIR || join(hostHome(env), '.claude')
  const configDir = ensureOwnedDirectory(
    absoluteConfiguredPath(configured, env, 'host CLAUDE_CONFIG_DIR'),
    'host Claude config directory'
  )
  let configuredSecureDir = env.CLAUDE_SECURESTORAGE_CONFIG_DIR
  if (!configuredSecureDir) {
    const settingsPath = join(configDir, 'settings.json')
    const settings = existsSync(settingsPath) ? jsonObject(settingsPath) : {}
    const rawSettingsEnv = settings.env
    if (
      rawSettingsEnv !== undefined &&
      (!rawSettingsEnv || typeof rawSettingsEnv !== 'object' || Array.isArray(rawSettingsEnv))
    ) {
      throw new Error(`Claude settings.env must contain a JSON object: ${settingsPath}`)
    }
    const settingsEnv = (rawSettingsEnv ?? {}) as Record<string, unknown>
    const setting = settingsEnv.CLAUDE_SECURESTORAGE_CONFIG_DIR
    if (setting !== undefined && typeof setting !== 'string') {
      throw new Error(`Claude settings env.CLAUDE_SECURESTORAGE_CONFIG_DIR must be a string: ${settingsPath}`)
    }
    configuredSecureDir = setting
  }
  const credentialDir = ensureOwnedDirectory(
    absoluteConfiguredPath(configuredSecureDir || configDir, env, 'Claude secure credential directory'),
    'Claude secure credential directory'
  )
  const destination = join(credentialDir, '.credentials.json')
  if (existsSync(destination)) secureCredentialFile(existingFileTarget(destination))

  return {
    // The ACP runtime has a private HOME, so pass the resolved host directory
    // explicitly even when Claude's default secure-storage location is used.
    env: { CLAUDE_SECURESTORAGE_CONFIG_DIR: credentialDir },
    writablePaths: [credentialDir],
    seedExclusions: [join('.claude', '.credentials.json')],
    preparePrivateHome: (runtimeHome) => {
      const privateCredential = join(runtimeHome, '.claude', '.credentials.json')
      const privateInfo = lstatIfPresent(privateCredential)
      if (!privateInfo) return
      if (privateInfo.isSymbolicLink()) {
        let linked: string
        try {
          linked = realpathSync(privateCredential)
        } catch {
          throw new Error(`private Claude credential link is dangling: ${privateCredential}`)
        }
        if (!existsSync(destination) || linked !== existingFileTarget(destination)) {
          throw new Error(
            `private Claude credential link points outside the shared host credential: ${privateCredential}`
          )
        }
        unlinkSync(privateCredential)
        return
      }
      if (!privateInfo.isFile()) {
        throw new Error(`private Claude credential path is not a regular file: ${privateCredential}`)
      }

      if (!existsSync(destination)) {
        renameSync(privateCredential, destination)
        secureCredentialFile(destination)
        return
      }
      const authoritative = existingFileTarget(destination)
      if (sameFileContents(privateCredential, authoritative)) {
        unlinkSync(privateCredential)
        return
      }
      const privateGeneration = claudeCredentialGeneration(privateCredential)
      const hostGeneration = claudeCredentialGeneration(authoritative)
      if (privateGeneration === undefined || hostGeneration === undefined || privateGeneration === hostGeneration) {
        throw new Error(
          `conflicting Claude credentials at ${privateCredential} and ${destination}; run host claude /login after resolving the conflict`
        )
      }
      if (privateGeneration > hostGeneration) {
        renameSync(privateCredential, authoritative)
        secureCredentialFile(authoritative)
      } else {
        unlinkSync(privateCredential)
      }
    }
  }
}

function refreshTimestamp(path: string): number | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { last_refresh?: unknown; lastRefresh?: unknown }
    const value = parsed.last_refresh ?? parsed.lastRefresh
    if (typeof value !== 'string') return undefined
    const timestamp = Date.parse(value)
    return Number.isFinite(timestamp) ? timestamp : undefined
  } catch {
    return undefined
  }
}

function prepareCodexCredentials(env: NodeJS.ProcessEnv): SharedRuntimeCredentialAccess {
  const configured = env.CODEX_HOME || join(hostHome(env), '.codex')
  const codexHome = ensureOwnedDirectory(absoluteConfiguredPath(configured, env, 'host CODEX_HOME'), 'host CODEX_HOME')
  const hostAuth = join(codexHome, 'auth.json')
  if (existsSync(hostAuth)) secureCredentialFile(existingFileTarget(hostAuth))
  const writablePaths = existsSync(hostAuth) ? [existingFileTarget(hostAuth)] : []

  return {
    env: {},
    // A missing file cannot be rebound by SRT. The private link remains
    // dangling until host `codex login` creates it; restarting the ACP host then
    // picks it up without ever copying the credential.
    writablePaths,
    seedExclusions: [join('.codex', 'auth.json')],
    preparePrivateHome: (runtimeHome) => {
      const privateDir = ensureOwnedDirectory(join(runtimeHome, '.codex'), 'private Codex config directory')
      const privateAuth = join(privateDir, 'auth.json')
      const privateInfo = lstatIfPresent(privateAuth)
      if (privateInfo) {
        const info = privateInfo
        if (info.isSymbolicLink()) {
          let linked: string | undefined
          try {
            linked = realpathSync(privateAuth)
          } catch {
            // A dangling link is valid when the host has not logged in yet.
          }
          const authoritative = existsSync(hostAuth) ? existingFileTarget(hostAuth) : undefined
          const lexicalTarget = resolve(dirname(privateAuth), readlinkSync(privateAuth))
          if ((linked && authoritative && linked !== authoritative) || (!linked && lexicalTarget !== hostAuth)) {
            throw new Error(`private Codex auth link points outside the shared host credential: ${privateAuth}`)
          }
          // Avoid a two-hop link through the hidden host HOME when auth.json is
          // itself linked elsewhere. The private HOME should point directly at
          // the exact writable file carved back into the sandbox.
          if (authoritative && lexicalTarget !== authoritative) {
            unlinkSync(privateAuth)
            symlinkSync(authoritative, privateAuth)
          }
          return
        }
        if (!info.isFile()) throw new Error(`private Codex auth path is not a regular file: ${privateAuth}`)

        if (!existsSync(hostAuth)) {
          renameSync(privateAuth, hostAuth)
          secureCredentialFile(hostAuth)
          writablePaths.push(hostAuth)
        } else {
          const authoritative = existingFileTarget(hostAuth)
          if (sameFileContents(privateAuth, authoritative)) {
            unlinkSync(privateAuth)
          } else {
            const privateRefresh = refreshTimestamp(privateAuth)
            const hostRefresh = refreshTimestamp(authoritative)
            if (privateRefresh === undefined || hostRefresh === undefined || privateRefresh === hostRefresh) {
              throw new Error(
                `conflicting Codex credentials at ${privateAuth} and ${hostAuth}; run host codex login after resolving the conflict`
              )
            }
            if (privateRefresh > hostRefresh) {
              renameSync(privateAuth, authoritative)
              secureCredentialFile(authoritative)
            } else {
              unlinkSync(privateAuth)
            }
          }
        }
      }
      if (!lstatIfPresent(privateAuth)) {
        symlinkSync(existsSync(hostAuth) ? existingFileTarget(hostAuth) : hostAuth, privateAuth)
      }
    }
  }
}

function moveCredentialFile(source: string, destination: string): void {
  try {
    renameSync(source, destination)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
    copyFileSync(source, destination, constants.COPYFILE_EXCL)
    unlinkSync(source)
  }
  secureCredentialFile(destination)
}

function regularFileIfPresent(path: string, label: string): ReturnType<typeof lstatSync> | undefined {
  const info = lstatIfPresent(path)
  if (!info) return undefined
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`${label} is not a regular file: ${path}`)
  return info
}

/** Fold a pre-shared-login private Qoder auth directory into the host directory.
 * The opaque `user` credential is never chosen silently: a divergent host/private
 * login fails closed. A private login may become authoritative only when the host
 * has no login yet; its paired machine id follows it. */
function migratePrivateQoderAuth(privateAuth: string, sharedAuth: string, label: string): void {
  const privateUser = join(privateAuth, 'user')
  const sharedUser = join(sharedAuth, 'user')
  const privateHasUser = regularFileIfPresent(privateUser, `${label} private user credential`) !== undefined
  const sharedHasUser = regularFileIfPresent(sharedUser, `${label} host user credential`) !== undefined

  if (privateHasUser && sharedHasUser && !sameFileContents(privateUser, sharedUser)) {
    throw new Error(
      `conflicting ${label} credentials at ${privateUser} and ${sharedUser}; run host ${label} /login after resolving the conflict`
    )
  }

  const privateLoginWins = privateHasUser && !sharedHasUser
  if (privateLoginWins) {
    moveCredentialFile(privateUser, sharedUser)
    const privateMachine = join(privateAuth, 'machine_id')
    const sharedMachine = join(sharedAuth, 'machine_id')
    if (regularFileIfPresent(privateMachine, `${label} private machine id`)) {
      if (regularFileIfPresent(sharedMachine, `${label} host machine id`)) unlinkSync(sharedMachine)
      moveCredentialFile(privateMachine, sharedMachine)
    }
  }

  for (const entry of readdirSync(privateAuth, { withFileTypes: true })) {
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error(`${label} private auth contains an unsupported entry: ${join(privateAuth, entry.name)}`)
    }
    const source = join(privateAuth, entry.name)
    const destination = join(sharedAuth, entry.name)
    regularFileIfPresent(source, `${label} private auth file`)
    const destinationInfo = regularFileIfPresent(destination, `${label} host auth file`)
    if (!destinationInfo) {
      moveCredentialFile(source, destination)
    } else if (
      sameFileContents(source, destination) ||
      entry.name === 'machine_id' ||
      entry.name === 'dynamic-error-codes.json' ||
      entry.name === 'dynamic-texts.json'
    ) {
      // Host login state wins over a logged-out private machine id; the other
      // two files are provider-owned caches, not credentials.
      unlinkSync(source)
    } else {
      throw new Error(
        `conflicting ${label} auth state at ${source} and ${destination}; run host ${label} /login after resolving the conflict`
      )
    }
  }
  rmdirSync(privateAuth)
}

function qoderConfigDirectory(profile: 'qoder' | 'qoder-cn', env: NodeJS.ProcessEnv): string {
  const cn = profile === 'qoder-cn'
  const configured = cn ? env.QODERCN_CONFIG_DIR : env.QODER_CONFIG_DIR
  const base = (cn ? env.QODERCN_CLI_HOME : env.QODER_CLI_HOME) || env.GEMINI_CLI_HOME
  const name = (
    (cn ? env.QODERCN_CONFIG_DIR_NAME : env.QODER_CONFIG_DIR_NAME) || (cn ? '.qoder-cn' : '.qoder')
  ).normalize('NFC')
  return ensureOwnedDirectory(
    absoluteConfiguredPath(
      configured || (base ? join(base, name) : join(hostHome(env), name)),
      env,
      `${profile} config`
    ),
    `host ${profile} config directory`
  )
}

function prepareQoderCredentials(profile: 'qoder' | 'qoder-cn', env: NodeJS.ProcessEnv): SharedRuntimeCredentialAccess {
  const configName = profile === 'qoder-cn' ? '.qoder-cn' : '.qoder'
  const sharedAuth = ensureOwnedDirectory(join(qoderConfigDirectory(profile, env), '.auth'), `host ${profile} auth`)
  return {
    env: {},
    writablePaths: [sharedAuth],
    seedExclusions: [join(configName, '.auth', 'user'), join(configName, '.auth', 'machine_id')],
    preparePrivateHome: (runtimeHome) => {
      const privateConfig = ensureOwnedDirectory(join(runtimeHome, configName), `private ${profile} config directory`)
      const privateAuth = join(privateConfig, '.auth')
      const privateInfo = lstatIfPresent(privateAuth)
      if (privateInfo?.isSymbolicLink()) {
        let linked: string
        try {
          linked = realpathSync(privateAuth)
        } catch {
          throw new Error(`private ${profile} auth link is dangling: ${privateAuth}`)
        }
        if (linked !== sharedAuth)
          throw new Error(`private ${profile} auth link points outside host credentials: ${privateAuth}`)
        return
      }
      if (privateInfo) {
        if (!privateInfo.isDirectory())
          throw new Error(`private ${profile} auth path is not a directory: ${privateAuth}`)
        migratePrivateQoderAuth(privateAuth, sharedAuth, profile)
      }
      symlinkSync(sharedAuth, privateAuth)
    }
  }
}

export function prepareSharedRuntimeCredentials(opts: {
  runtimeId: string
  runtime?: RuntimeDef
  hostEnv?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
}): SharedRuntimeCredentialAccess | undefined {
  if ((opts.platform ?? process.platform) !== 'linux') return undefined
  const profile = sharedCredentialProfile(opts.runtimeId, opts.runtime)
  if (!profile) return undefined
  const env = opts.hostEnv ?? process.env
  if (profile === 'claude') return prepareClaudeCredentials(env)
  if (profile === 'codex') return prepareCodexCredentials(env)
  return prepareQoderCredentials(profile, env)
}
