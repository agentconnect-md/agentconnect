import {
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { home as hostHomeDir, runtimeStateLocations } from './probe.js'
import { extractOmpCredentials } from './omp-credentials.js'

const MAX_SEED_FILE_BYTES = 2 * 1024 * 1024
const LEGACY_RUNTIME_STATE: Record<string, string[]> = {
  'claude-acp': ['.claude'],
  'codex-acp': ['.codex']
}

/** Persistent private user environment for an agent runtime while it is sandboxed. */
export function runtimeHomePath(scopeDir: string): string {
  return join(resolve(scopeDir), 'home')
}

function ensurePrivateDir(path: string): void {
  if (existsSync(path)) {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`runtime HOME path is not a real directory: ${path}`)
    }
  }
  mkdirSync(path, { recursive: true, mode: 0o700 })
  try {
    chmodSync(path, 0o700)
  } catch {
    // Windows and unusual filesystems may not implement POSIX modes.
  }
}

function containedDestination(home: string, destination: string): string {
  if (isAbsolute(destination)) throw new Error(`runtime HOME destination must be relative: ${destination}`)
  const target = resolve(home, destination)
  const rel = relative(home, target)
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`runtime HOME destination escapes the private HOME: ${destination}`)
  }
  return target
}

function assertNoDestinationSymlink(home: string, target: string): void {
  let current = home
  for (const part of relative(home, target).split(sep).filter(Boolean)) {
    current = join(current, part)
    if (!existsSync(current)) return
    if (lstatSync(current).isSymbolicLink()) {
      throw new Error(`runtime HOME destination contains a symlink: ${current}`)
    }
  }
}

function projectedJson(source: string, keys: readonly string[]): string | undefined {
  const raw = readFileSync(source, 'utf8')
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  const sourceObject = parsed as Record<string, unknown>
  const projected: Record<string, unknown> = {}
  for (const key of keys) {
    if (Object.hasOwn(sourceObject, key)) projected[key] = sourceObject[key]
  }
  if (Object.keys(projected).length === 0) return undefined
  return `${JSON.stringify(projected)}\n`
}

function copySeedFile(
  source: string,
  destination: string,
  excludedDestinations: ReadonlySet<string>,
  seedJsonKeys?: readonly string[]
): void {
  if (excludedDestinations.has(destination)) return
  if (existsSync(destination)) {
    if (lstatSync(destination).isSymbolicLink()) {
      throw new Error(`runtime HOME destination contains a symlink: ${destination}`)
    }
    return
  }
  let stat
  try {
    stat = lstatSync(source)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_SEED_FILE_BYTES) return
  ensurePrivateDir(dirname(destination))
  try {
    if (seedJsonKeys) {
      const projected = projectedJson(source, seedJsonKeys)
      if (projected === undefined) return
      writeFileSync(destination, projected, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    } else {
      copyFileSync(source, destination, constants.COPYFILE_EXCL)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return
    throw error
  }
  try {
    chmodSync(destination, seedJsonKeys ? 0o600 : stat.mode & 0o700 ? stat.mode & 0o700 : 0o600)
  } catch {
    // Best effort; the private parent still prevents access by other users.
  }
}

/** Config roots can contain gigabytes of sessions/logs. Seed only their small,
 * top-level auth/settings/config files; runtime-generated state starts private. */
function isConfigFile(name: string): boolean {
  const lower = name.toLowerCase()
  return (
    /\.(json|toml|ya?ml)$/.test(lower) ||
    /(^|[._-])(auth|credential|config|settings|account|profile|token|oauth|installation)([._-]|$)/.test(lower)
  )
}

function seedLocation(
  home: string,
  source: string,
  destination: string,
  excludedDestinations: ReadonlySet<string>,
  seedFiles?: readonly string[],
  seedJsonKeys?: readonly string[]
): void {
  let stat
  try {
    stat = lstatSync(source)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  if (stat.isSymbolicLink()) return
  if (stat.isFile()) {
    copySeedFile(source, destination, excludedDestinations, seedJsonKeys)
    return
  }
  if (!stat.isDirectory()) return

  ensurePrivateDir(destination)
  if (seedFiles) {
    for (const file of seedFiles) {
      const sourceFile = containedDestination(source, file)
      const destinationFile = containedDestination(destination, file)
      assertNoDestinationSymlink(home, destinationFile)
      copySeedFile(sourceFile, destinationFile, excludedDestinations, seedJsonKeys)
    }
    return
  }
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (!entry.isFile() || !isConfigFile(entry.name)) continue
    copySeedFile(join(source, entry.name), join(destination, entry.name), excludedDestinations, seedJsonKeys)
  }
}

/** Initialize the runtime's conventional config locations from the real host HOME.
 * Existing private files always win, so later starts never overwrite agent state. */
export function prepareRuntimeHome(
  runtimeId: string,
  scopeDir: string,
  hostEnv: NodeJS.ProcessEnv = process.env,
  targetHome?: string,
  excludedDestinations: readonly string[] = []
): string {
  const home = targetHome ? resolve(targetHome) : runtimeHomePath(scopeDir)
  ensurePrivateDir(home)
  const excluded = new Set(excludedDestinations.map((destination) => containedDestination(home, destination)))
  const locations = runtimeStateLocations(runtimeId, hostEnv)
  // rc.6-era native memory supported Claude and Codex and lived directly under
  // the agent root. Move only those historical paths before host seeding.
  if (!targetHome) {
    for (const entry of LEGACY_RUNTIME_STATE[runtimeId] ?? []) {
      const legacy = join(resolve(scopeDir), entry)
      const destination = join(home, entry)
      if (!existsSync(legacy) || existsSync(destination)) continue
      if (lstatSync(legacy).isSymbolicLink()) {
        throw new Error(`legacy runtime state is a symlink: ${legacy}`)
      }
      renameSync(legacy, destination)
    }
  }
  for (const location of locations) {
    const destination = containedDestination(home, location.destination)
    assertNoDestinationSymlink(home, destination)
    seedLocation(home, location.source, destination, excluded, location.seedFiles, location.seedJsonKeys)
    if (runtimeId === 'omp') {
      extractOmpCredentials(join(location.source, 'agent.db'), join(destination, 'agent.db'))
    }
  }
  return home
}

const AMBIENT_STATE_ENV = new Set([
  'HOME',
  'USERPROFILE',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'CARGO_HOME',
  'RUSTUP_HOME',
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  'COPILOT_HOME',
  'CURSOR_CONFIG_DIR',
  'HERMES_HOME',
  'INTERPRETER_HOME',
  'KIRO_HOME',
  'ZEROCLAW_CONFIG_DIR',
  'ZEROCLAW_DATA_DIR',
  'AMP_SETTINGS_FILE',
  'PI_CODING_AGENT_DIR',
  'CLINE_DIR',
  'CLINE_DATA_DIR',
  'CLINE_PROVIDER_SETTINGS_PATH',
  'KIMI_CODE_HOME',
  // Qoder (a Gemini-CLI fork) resolves its config + agents dirs from these; drop
  // the host values so the child falls back to the private HOME. Covers both the
  // international and CN brands plus the shared Gemini fallback.
  'QODER_CONFIG_DIR',
  'QODER_CLI_HOME',
  'QODERCN_CONFIG_DIR',
  'QODERCN_CLI_HOME',
  'GEMINI_CLI_HOME',
  // DeepSeek Harness state root; $DSH_PATH (the harness install location) is not
  // user state and stays inherited.
  'DSH_HOME',
  // OpenClaw state/config roots. The gateway connection overrides
  // ($OPENCLAW_GATEWAY_URL/_TOKEN/_PASSWORD) are credentials, not state — inherited.
  'OPENCLAW_HOME',
  'OPENCLAW_STATE_DIR',
  'OPENCLAW_CONFIG_PATH'
])

function inheritedEnvironment(source: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined || AMBIENT_STATE_ENV.has(name)) continue
    // npm's ambient cache/userconfig overrides defeat HOME isolation. Explicit
    // runtime/agent env is merged later and may intentionally add them back.
    if (name.startsWith('NPM_CONFIG_') || name.startsWith('npm_config_')) continue
    out[name] = value
  }
  return out
}

/** Launcher caches a disposable probe HOME keeps on the HOST: npx/uvx otherwise rebuild
 *  their whole install tree per sweep (~210s for a 700-package harness), and the bytes
 *  are content-addressed packages, not user state. Probe launches only — see the
 *  `hostPackageCache` option in prepareRuntimeLaunch for why an agent must not get it. */
export function hostPackageCacheEnv(
  command: string | undefined,
  hostEnv: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  if (command === 'npx') {
    return {
      npm_config_cache: hostEnv.npm_config_cache || hostEnv.NPM_CONFIG_CACHE || join(hostHomeDir(hostEnv), '.npm')
    }
  }
  if (command === 'uvx') {
    const cacheHome = hostEnv.XDG_CACHE_HOME || join(hostHomeDir(hostEnv), '.cache')
    return { UV_CACHE_DIR: hostEnv.UV_CACHE_DIR || join(cacheHome, 'uv') }
  }
  return {}
}

type RuntimePrivateEnv = (home: string, hostEnv: NodeJS.ProcessEnv) => Record<string, string>

const RUNTIME_PRIVATE_ENV: Record<string, RuntimePrivateEnv> = {
  'claude-acp': (home) => ({ CLAUDE_CONFIG_DIR: join(home, '.claude') }),
  'codex-acp': (home) => ({ CODEX_HOME: join(home, '.codex') }),
  'github-copilot-cli': (home) => ({ COPILOT_HOME: join(home, '.copilot') }),
  cursor: (home) => ({ CURSOR_CONFIG_DIR: join(home, '.cursor') }),
  'hermes-agent': (home) => ({ HERMES_HOME: join(home, '.hermes') }),
  hermes: (home) => ({ HERMES_HOME: join(home, '.hermes') }),
  'open-interpreter': (home) => ({
    INTERPRETER_HOME: join(home, '.openinterpreter'),
    CODEX_HOME: join(home, '.codex')
  }),
  'kiro-cli': (home) => ({ KIRO_HOME: join(home, '.kiro') }),
  zeroclaw: (home) => ({
    ZEROCLAW_CONFIG_DIR: join(home, '.zeroclaw'),
    ZEROCLAW_DATA_DIR: join(home, '.zeroclaw', 'data')
  }),
  // Pin global state even when CONFIG_DIR_NAME is customized. That variable may
  // still select the project-local directory, but auth always resolves through
  // the reviewed private-HOME link prepared by runtime-credentials.
  'qoder-cli': (home) => ({ QODER_CONFIG_DIR: join(home, '.qoder') }),
  'qoder-cli-cn': (home) => ({ QODERCN_CONFIG_DIR: join(home, '.qoder-cn') }),
  omp: (home) => ({ PI_CODING_AGENT_DIR: join(home, '.omp', 'agent') }),
  'pi-acp': (home) => ({ PI_CODING_AGENT_DIR: join(home, '.pi', 'agent') }),
  cline: (home) => ({
    CLINE_DIR: join(home, '.cline'),
    CLINE_DATA_DIR: join(home, '.cline', 'data')
  }),
  'amp-acp': (home, hostEnv) => {
    const env: Record<string, string> = {}
    if (hostEnv.AMP_SETTINGS_FILE) {
      env.AMP_SETTINGS_FILE = join(home, '.config', 'amp', basename(hostEnv.AMP_SETTINGS_FILE))
    }
    return env
  },
  'dsh-acp': (home) => ({ DSH_HOME: join(home, '.dsh') }),
  openclaw: (home) => ({ OPENCLAW_STATE_DIR: join(home, '.openclaw') }),
  kimi: (home, hostEnv) => {
    const env: Record<string, string> = {}
    if (hostEnv.KIMI_CODE_HOME) env.KIMI_CODE_HOME = join(home, '.kimi-code')
    return env
  }
}

/** Build the exact child environment. Host PATH/network/provider env survives, while
 * all conventional user state resolves below the private runtime HOME. */
export function runtimeHomeEnvironment(
  runtimeId: string,
  home: string,
  explicitEnv: Record<string, string> = {},
  hostEnv: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  return {
    ...inheritedEnvironment(hostEnv),
    ...explicitEnv,
    HOME: home,
    ...(process.platform === 'win32' ? { USERPROFILE: home } : {}),
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_CACHE_HOME: join(home, '.cache'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
    ...(RUNTIME_PRIVATE_ENV[runtimeId]?.(home, hostEnv) ?? {})
  }
}
