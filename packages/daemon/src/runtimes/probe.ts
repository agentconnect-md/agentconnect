import { accessSync, constants, existsSync } from 'node:fs'
import { basename, delimiter, dirname, join } from 'node:path'
import { homedir } from 'node:os'
import type { RuntimeDef } from '../config/config-schema.js'
import { CURATED_RUNTIME_CATALOG } from './curated.js'
import { parseArchiveLaunch } from './archive-store.js'
import type { ResolvedRuntimeCatalog } from './registry.js'
import type { SeededCredentialFile } from './runtime-seeded-credentials.js'
import { resolveClaudeConfigSources, resolveOmpCredentialSource } from './runtime-credential-sources.js'

// Direct executables establish installation; package launchers still need the product's own host state.

const isWin = process.platform === 'win32'

function isExecutableFile(p: string): boolean {
  try {
    // X_OK is meaningless on Windows; fall back to mere existence there.
    accessSync(p, isWin ? constants.F_OK : constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Resolve a launcher command the way a shell would. A command containing a path
 * separator is treated as a literal path; a bare name is searched across `$PATH`
 * (trying `$PATHEXT` extensions on Windows).
 */
export function isCommandAvailable(command: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveCommandPath(command, env) !== undefined
}

/**
 * Resolve a launcher/command to its absolute path the way a shell would — a path
 * containing a separator is checked literally; a bare name is searched across
 * `$PATH` (trying `$PATHEXT` extensions on Windows). Returns undefined if not found.
 */
export function resolveCommandPath(command: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  // Windows cannot spawn extensionless npm launcher scripts directly. Prefer PATHEXT
  // executables (notably npx.cmd) before an extensionless sibling.
  const exts = isWin ? [...(env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';'), ''] : ['']
  const hasSep = command.includes('/') || (isWin && command.includes('\\'))
  if (hasSep) {
    // Try as a literal path relative to CWD first (covers auto-downloaded archives
    // where the binary sits in the extraction directory).
    const literal = exts.map((ext) => command + ext).find(isExecutableFile)
    if (literal) return literal
    // Not found as a literal path — the ACP registry stores binary commands with a
    // `./` prefix ("./opencode", "./goose", …) which is meaningful when the daemon
    // downloads and extracts the archive itself, but the tool may also be installed
    // directly on `$PATH` as just the basename. Fall back to PATH search with the
    // basename (stripping any directory prefix) so the probe finds it either way.
    const basename = command.split(/[/\\]/).filter(Boolean).pop() ?? command
    if (basename !== command) {
      const dirs = (env.PATH ?? '').split(delimiter).filter(Boolean)
      for (const dir of dirs) {
        for (const ext of exts) {
          const p = join(dir, basename) + ext
          if (isExecutableFile(p)) return p
        }
      }
    }
    return undefined
  }
  const dirs = (env.PATH ?? '').split(delimiter).filter(Boolean)
  for (const dir of dirs) {
    for (const ext of exts) {
      const p = join(dir, command) + ext
      if (isExecutableFile(p)) return p
    }
  }
  return undefined
}

/** Extra, runtime-specific check layered (AND) on top of the launcher probe. */
export type RuntimeProbe = (env: NodeJS.ProcessEnv) => boolean

/** Host runtime state that can initialize an agent's private runtime HOME. */
export interface RuntimeStateLocation {
  source: string
  /** Exact credential files shared by private-HOME seeding and opt-in credential discovery. */
  credentialFiles?: readonly SeededCredentialFile[]
  /** Path relative to the private runtime HOME. */
  destination: string
  /**
   * Optional paths, relative to the source/destination roots, that are safe to
   * seed. Omitted means the generic shallow config-file policy applies.
   */
  seedFiles?: readonly string[]
  /**
   * Optional top-level JSON keys to project instead of copying each selected
   * source file wholesale. Invalid JSON or a source with none of these keys is
   * not seeded.
   */
  seedJsonKeys?: readonly string[]
}

// --- home / XDG path resolution (honors the standard env overrides) ----------

export function home(env: NodeJS.ProcessEnv): string {
  // USERPROFILE first on Windows — a runtime's own `~` — then HOME, the way Git for Windows reads it,
  // so a caller pinning only HOME is honored instead of resolving to the daemon's own home.
  return (isWin ? env.USERPROFILE || env.HOME : env.HOME) || homedir()
}
function xdgConfigHome(env: NodeJS.ProcessEnv): string {
  return env.XDG_CONFIG_HOME || join(home(env), '.config')
}
function xdgDataHome(env: NodeJS.ProcessEnv): string {
  return env.XDG_DATA_HOME || join(home(env), '.local', 'share')
}
function xdgStateHome(env: NodeJS.ProcessEnv): string {
  return env.XDG_STATE_HOME || join(home(env), '.local', 'state')
}
function pathExists(p: string | undefined): boolean {
  return !!p && existsSync(p)
}
/** True if any candidate path exists (undefined candidates are skipped). */
function anyExists(...candidates: (string | undefined)[]): boolean {
  return candidates.some(pathExists)
}

type RuntimeStateLocator = (env: NodeJS.ProcessEnv) => RuntimeStateLocation[]

function state(
  source: string | undefined,
  destination: string,
  seedFiles?: readonly string[],
  seedJsonKeys?: readonly string[],
  credentialFiles?: readonly SeededCredentialFile[]
): RuntimeStateLocation[] {
  return source
    ? [
        {
          source,
          destination,
          ...(seedFiles ? { seedFiles } : {}),
          ...(seedJsonKeys ? { seedJsonKeys } : {}),
          ...(credentialFiles ? { credentialFiles } : {})
        }
      ]
    : []
}

/**
 * Runtime state locations keyed by ACP-registry id. They serve two related paths:
 * the host-side availability probe below and first-use initialization of a private
 * per-agent runtime HOME. Sources honor host env overrides; destinations always use
 * the runtime's conventional layout under the private HOME.
 */
/** Config + legacy browser-login files a Qoder edition writes under its config
 * dir. Current `.auth/` login state is shared separately by runtime-credentials;
 * `brand` is the legacy credential-file prefix (`qoder-cli`/`qoder-cli-cn`). */
const QODER_SEED = (brand: string): readonly string[] => [
  'settings.json',
  'config.json',
  'google_accounts.json',
  '.keychain-salt',
  `${brand}-credentials.json`,
  'mcp-oauth-tokens.json',
  'a2a-oauth-tokens.json'
]
const CLAUDE_GLOBAL_SEED_KEYS = ['additionalModelOptionsCache', 'primaryApiKey'] as const
/** DeepSeek Harness auth: the managed 0600 credential store plus its .env fallback. */
const DSH_CREDENTIALS = [
  { path: '.credentials.yaml', format: 'dsh' },
  { path: '.env', format: 'dsh-env' }
] as const
/** Antigravity settings and CLI state; ACP login files are declared separately. */
const ANTIGRAVITY_SEED = ['settings.json', 'antigravity-oauth-token', 'installation_id'] as const
/** OpenClaw acp bridge inputs: gateway address + token config and its .env fallback. */
const OPENCLAW_SEED = ['openclaw.json', '.env'] as const

export const RUNTIME_STATE_LOCATIONS: Record<string, RuntimeStateLocator> = {
  // Project only the active global file's saved API key and rollout cache; session and MCP state stay private.
  'claude-acp': (env) => {
    const { configDir, globalConfigFile } = resolveClaudeConfigSources(env)
    if (dirname(globalConfigFile) === configDir) {
      return [
        ...state(configDir, '.claude', [basename(globalConfigFile)], CLAUDE_GLOBAL_SEED_KEYS),
        ...state(join(home(env), '.claude.json'), '.claude.json', undefined, ['additionalModelOptionsCache'])
      ]
    }
    return [
      ...state(globalConfigFile, '.claude.json', undefined, CLAUDE_GLOBAL_SEED_KEYS),
      ...state(globalConfigFile, join('.claude', '.claude.json'), undefined, CLAUDE_GLOBAL_SEED_KEYS),
      ...state(configDir, '.claude', [])
    ]
  },

  // OpenAI Codex CLI — ~/.codex (honors $CODEX_HOME).
  'codex-acp': (env) => [...state(env.CODEX_HOME, '.codex'), ...state(join(home(env), '.codex'), '.codex')],

  // Google Gemini CLI — ~/.gemini, which the Antigravity CLI also writes into (its own
  // `antigravity-cli/`, `antigravity-acp/`, and `config/` subdirs), so the shared root is not a
  // signal for either: probe this CLI's own top-level files, plus `tmp/` as a ran-here marker that
  // seeds nothing.
  gemini: (env) => [
    ...state(join(home(env), '.gemini', 'settings.json'), join('.gemini', 'settings.json')),
    ...state(
      join(home(env), '.gemini', 'oauth_creds.json'),
      join('.gemini', 'oauth_creds.json'),
      undefined,
      undefined,
      [{ path: '', format: 'oauth', provider: 'google' }]
    ),
    ...state(join(home(env), '.gemini', 'google_accounts.json'), join('.gemini', 'google_accounts.json')),
    ...state(join(home(env), '.gemini', 'tmp'), join('.gemini', 'tmp'), [])
  ],

  // Qwen Code (Gemini-CLI fork) — ~/.qwen.
  'qwen-code': (env) =>
    state(join(home(env), '.qwen'), '.qwen', undefined, undefined, [
      { path: 'oauth_creds.json', format: 'oauth', provider: 'qwen' },
      { path: 'settings.json', format: 'qwen-settings' }
    ]),

  // GitHub Copilot CLI — ~/.copilot (honors $COPILOT_HOME).
  'github-copilot-cli': (env) =>
    state(env.COPILOT_HOME || join(home(env), '.copilot'), '.copilot', undefined, undefined, [
      { path: 'config.json', format: 'copilot' }
    ]),

  // Cursor CLI — ~/.cursor is shared with the editor, so probe the CLI-specific
  // config file (honors $CURSOR_CONFIG_DIR).
  cursor: (env) => [
    ...state(
      env.CURSOR_CONFIG_DIR ? join(env.CURSOR_CONFIG_DIR, 'cli-config.json') : undefined,
      join('.cursor', 'cli-config.json')
    ),
    ...state(join(home(env), '.cursor', 'cli-config.json'), join('.cursor', 'cli-config.json'))
  ],

  // sst OpenCode — XDG config dir + auth file under XDG data. `~/.opencode` is the
  // project-level config dir, not the documented global one, but it lands in $HOME
  // when opencode is run from home, so accept it as a fallback signal.
  opencode: (env) => [
    ...state(join(xdgConfigHome(env), 'opencode'), join('.config', 'opencode')),
    ...state(
      join(xdgDataHome(env), 'opencode', 'auth.json'),
      join('.local', 'share', 'opencode', 'auth.json'),
      undefined,
      undefined,
      [{ path: '', format: 'opencode' }]
    ),
    ...state(join(home(env), '.opencode'), '.opencode')
  ],

  // pi imports auth/model configuration; sessions, binaries and adapter state remain agent-private.
  'pi-acp': (env) => [
    ...state(
      join(env.PI_CODING_AGENT_DIR || join(home(env), '.pi', 'agent'), 'auth.json'),
      join('.pi', 'agent', 'auth.json'),
      undefined,
      undefined,
      [{ path: '', format: 'pi' }]
    ),
    ...state(
      join(env.PI_CODING_AGENT_DIR || join(home(env), '.pi', 'agent'), 'models.json'),
      join('.pi', 'agent', 'models.json'),
      undefined,
      undefined,
      [{ path: '', format: 'pi-models' }]
    ),
    ...state(env.PI_CODING_AGENT_DIR, join('.pi', 'agent'), ['settings.json']),
    ...state(join(home(env), '.pi'), '.pi', [join('agent', 'settings.json')])
  ],

  // Nous Research Hermes — ~/.hermes (honors $HERMES_HOME, which relocates the
  // whole home dir). Keep both the canonical proposed registry id and the legacy
  // AgentConnect alias on the same reviewed allowlist.
  'hermes-agent': (env) => [
    ...state(env.HERMES_HOME || join(home(env), '.hermes'), '.hermes', ['.env', 'config.yaml'], undefined, [
      { path: 'auth.json', format: 'hermes' },
      { path: '.anthropic_oauth.json', format: 'claude-oauth', provider: 'anthropic' },
      { path: '.env', format: 'dsh-env' }
    ]),
    ...state(join(home(env), '.hermes'), '.hermes', ['.env', 'config.yaml'])
  ],
  hermes: (env) => RUNTIME_STATE_LOCATIONS['hermes-agent']!(env),

  // Open Interpreter native Rust ACP client.
  'open-interpreter': (env) => [
    ...state(env.INTERPRETER_HOME, '.openinterpreter', ['config.toml', 'auth.json']),
    ...state(join(home(env), '.openinterpreter'), '.openinterpreter', ['config.toml', 'auth.json'])
  ],

  // Kiro CLI — settings are safe to seed; sessions/history remain private.
  'kiro-cli': (env) => [
    ...state(env.KIRO_HOME, '.kiro', [join('settings', 'cli.json')]),
    ...state(join(home(env), '.kiro'), '.kiro', [join('settings', 'cli.json')])
  ],

  // Maki uses XDG roots and retains ~/.maki as a legacy fallback. Data/state
  // roots are discovery signals only (empty allowlist = copy nothing).
  maki: (env) => [
    ...state(join(xdgConfigHome(env), 'maki'), join('.config', 'maki'), ['init.lua', 'permissions.toml', 'mcp.toml']),
    ...state(join(xdgDataHome(env), 'maki'), join('.local', 'share', 'maki'), []),
    ...state(join(xdgStateHome(env), 'maki'), join('.local', 'state', 'maki'), []),
    ...state(join(home(env), '.maki'), '.maki', ['init.lua', 'permissions.toml', 'mcp.toml'])
  ],

  // ZeroClaw config and generated data can be relocated independently.
  zeroclaw: (env) => [
    ...state(env.ZEROCLAW_CONFIG_DIR, '.zeroclaw', ['config.toml']),
    ...state(env.ZEROCLAW_DATA_DIR, join('.zeroclaw', 'data'), []),
    ...state(join(home(env), '.zeroclaw'), '.zeroclaw', ['config.toml'])
  ],

  // Oh My Pi — agent.db is handled by the structured credential extractor in
  // runtime-home.ts; the ordinary file seeder copies config only.
  omp: (env) => state(dirname(resolveOmpCredentialSource(env)), join('.omp', 'agent'), ['config.yml']),

  // Qoder CLI (a Gemini-CLI fork) — global config dir defaults to ~/.qoder, but
  // $QODER_CONFIG_DIR overrides it outright and $QODER_CLI_HOME / $GEMINI_CLI_HOME
  // relocate the home base it (and the agents dir) sit under. Honor all three so
  // the probe finds a relocated install and seeds it into the private HOME. Seed
  // config + browser-login credentials: the encrypted token file and its
  // `.keychain-salt` (the AES key is scrypt(salt), not machine-bound, so both
  // together decrypt in the private HOME); sessions/workflows stay private.
  'qoder-cli': (env) => {
    const base = env.QODER_CLI_HOME || env.GEMINI_CLI_HOME
    const name = (env.QODER_CONFIG_DIR_NAME || '.qoder').normalize('NFC')
    return [
      ...state(env.QODER_CONFIG_DIR, '.qoder', QODER_SEED('qoder-cli')),
      ...state(base ? join(base, name) : undefined, '.qoder', QODER_SEED('qoder-cli')),
      ...state(join(home(env), name), '.qoder', QODER_SEED('qoder-cli'))
    ]
  },

  // Qoder CN CLI (Lingma) — same fork, China brand: ~/.qoder-cn, overridden by
  // $QODERCN_CONFIG_DIR / $QODERCN_CLI_HOME (or the shared $GEMINI_CLI_HOME).
  'qoder-cli-cn': (env) => {
    const base = env.QODERCN_CLI_HOME || env.GEMINI_CLI_HOME
    const name = (env.QODERCN_CONFIG_DIR_NAME || '.qoder-cn').normalize('NFC')
    return [
      ...state(env.QODERCN_CONFIG_DIR, '.qoder-cn', QODER_SEED('qoder-cli-cn')),
      ...state(base ? join(base, name) : undefined, '.qoder-cn', QODER_SEED('qoder-cli-cn')),
      ...state(join(home(env), name), '.qoder-cn', QODER_SEED('qoder-cli-cn'))
    ]
  },

  // Block goose — $XDG_CONFIG_HOME/goose.
  goose: (env) => state(join(xdgConfigHome(env), 'goose'), join('.config', 'goose')),

  // Sourcegraph Amp — $XDG_CONFIG_HOME/amp (honors $AMP_SETTINGS_FILE).
  'amp-acp': (env) => [
    ...state(
      join(xdgDataHome(env), 'amp', 'secrets.json'),
      join('.local', 'share', 'amp', 'secrets.json'),
      undefined,
      undefined,
      [{ path: '', format: 'amp' }]
    ),
    ...state(
      env.AMP_SETTINGS_FILE,
      join('.config', 'amp', env.AMP_SETTINGS_FILE ? basename(env.AMP_SETTINGS_FILE) : 'settings.json')
    ),
    ...state(join(xdgConfigHome(env), 'amp'), join('.config', 'amp'))
  ],

  // Augment auggie — ~/.augment.
  auggie: (env) =>
    state(join(home(env), '.augment'), '.augment', undefined, undefined, [{ path: 'session.json', format: 'auggie' }]),

  // Cline CLI — provider credentials live in <data-dir>/settings/providers.json.
  // CLINE_DATA_DIR names the data dir itself (normally ~/.cline/data), not ~/.cline.
  cline: (env) => [
    ...state(
      env.CLINE_PROVIDER_SETTINGS_PATH?.trim() ||
        join(
          env.CLINE_DATA_DIR?.trim() || join(env.CLINE_DIR?.trim() || join(home(env), '.cline'), 'data'),
          'settings',
          'providers.json'
        ),
      join('.cline', 'data', 'settings', 'providers.json'),
      undefined,
      undefined,
      [{ path: '', format: 'cline' }]
    ),
    ...state(env.CLINE_DATA_DIR, join('.cline', 'data'), []),
    ...state(env.CLINE_DIR, '.cline', []),
    ...state(join(home(env), '.cline'), '.cline', [])
  ],

  // Grok's exact login source precedes its ordinary config files when seeding the private HOME.
  'grok-build': (env) => [
    ...state(
      env.GROK_AUTH_PATH || join(env.GROK_HOME || join(home(env), '.grok'), 'auth.json'),
      join('.grok', 'auth.json'),
      undefined,
      undefined,
      [{ path: '', format: 'grok' }]
    ),
    ...state(env.GROK_HOME || join(home(env), '.grok'), '.grok')
  ],

  // Moonshot Kimi CLI — ~/.kimi (legacy) or ~/.kimi-code (newer, honors $KIMI_CODE_HOME).
  kimi: (env) => [
    ...state(env.KIMI_CODE_HOME || join(home(env), '.kimi-code'), '.kimi-code', undefined, undefined, [
      { path: join('credentials', 'kimi-code.json'), format: 'oauth', provider: 'kimi-code' }
    ]),
    ...state(env.KIMI_SHARE_DIR || join(home(env), '.kimi'), '.kimi', undefined, undefined, [
      { path: join('credentials', 'kimi-code.json'), format: 'oauth', provider: 'kimi-code' }
    ]),
    ...state(join(home(env), '.kimi'), '.kimi'),
    ...state(join(home(env), '.kimi-code'), '.kimi-code')
  ],

  // Factory Droid — ~/.factory.
  'factory-droid': (env) => state(join(home(env), '.factory'), '.factory'),

  // DeepSeek Harness (via the dsh-acp adapter) — $DSH_HOME, default ~/.dsh. Seed
  // only the managed credential store and its .env fallback; sessions and logs
  // in the same directory stay agent-private.
  'dsh-acp': (env) => [
    ...state(env.DSH_HOME || join(home(env), '.dsh'), '.dsh', [], undefined, DSH_CREDENTIALS),
    ...state(join(home(env), '.dsh'), '.dsh', [])
  ],

  // OpenClaw — ~/.openclaw, relocatable via $OPENCLAW_STATE_DIR (the dir itself),
  // $OPENCLAW_HOME (the home base), or $OPENCLAW_CONFIG_PATH (the config file
  // alone). The `acp` bridge is stateless; seed only the gateway config it
  // reads, gateway-side sessions/state stay agent-private.
  openclaw: (env) => [
    ...state(env.OPENCLAW_CONFIG_PATH, join('.openclaw', 'openclaw.json')),
    ...state(env.OPENCLAW_STATE_DIR, '.openclaw', OPENCLAW_SEED),
    ...state(env.OPENCLAW_HOME ? join(env.OPENCLAW_HOME, '.openclaw') : undefined, '.openclaw', OPENCLAW_SEED),
    ...state(join(home(env), '.openclaw'), '.openclaw', OPENCLAW_SEED)
  ],

  // Antigravity ACP uses its own consumer/business login files, separate from the CLI token.
  'antigravity-acp': (env) => {
    const root = (env.GEMINI_HOME || join(home(env), '.gemini')).replace(/^~(?=$|\/)/, home(env))
    return [
      ...state(join(root, 'antigravity-acp'), join('.gemini', 'antigravity-acp'), ANTIGRAVITY_SEED, undefined, [
        { path: 'acp_token.json', format: 'oauth', provider: 'google' },
        { path: 'acp_business_token.json', format: 'oauth', provider: 'google' }
      ]),
      ...state(join(root, 'antigravity-cli'), join('.gemini', 'antigravity-cli'), ANTIGRAVITY_SEED)
    ]
  },

  // Cognition Devin (for Terminal) — XDG config + data dirs.
  devin: (env) => [
    ...state(join(xdgConfigHome(env), 'devin'), join('.config', 'devin')),
    ...state(join(xdgDataHome(env), 'devin'), join('.local', 'share', 'devin'), undefined, undefined, [
      { path: 'credentials.toml', format: 'devin' }
    ])
  ]
}

export function runtimeStateLocations(id: string, env: NodeJS.ProcessEnv): RuntimeStateLocation[] {
  return RUNTIME_STATE_LOCATIONS[id]?.(env) ?? []
}

/** Custom probes keyed by ACP-registry runtime id. */
export const CUSTOM_PROBES: Record<string, RuntimeProbe> = Object.fromEntries(
  Object.keys(RUNTIME_STATE_LOCATIONS).map((id) => [
    id,
    (env: NodeJS.ProcessEnv) => {
      const locations = runtimeStateLocations(id, env)
      return anyExists(...locations.map((entry) => entry.source))
    }
  ])
)

/**
 * Package launchers that fetch-and-run on demand. When a runtime is launched via
 * one of these, the launcher being on `$PATH` says nothing about whether the
 * wrapped agent is installed, so such runtimes require a custom probe to count.
 */
export const PACKAGE_LAUNCHERS = new Set(['npx', 'uvx'])
const CURATED_RUNTIME_IDS = new Set([...Object.keys(CURATED_RUNTIME_CATALOG), 'hermes'])

/** Is this runtime actually usable on this host? */
export function isRuntimeAvailable(id: string, rt: RuntimeDef, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!isCommandAvailable(rt.command, env)) return false
  // A real executable needs no login or initialized HOME to count as installed.
  return !PACKAGE_LAUNCHERS.has(rt.command) || (CUSTOM_PROBES[id]?.(env) ?? false)
}

/**
 * Filter a runtime map down to those installed on this host — what the daemon
 * should report to the Control Plane and is able to launch.
 */
export function installedRuntimes(
  runtimes: Record<string, RuntimeDef>,
  env: NodeJS.ProcessEnv = process.env
): Record<string, RuntimeDef> {
  const out: Record<string, RuntimeDef> = {}
  for (const [id, rt] of Object.entries(runtimes)) {
    if (isRuntimeAvailable(id, rt, env)) out[id] = rt
  }
  return out
}

/**
 * Source-aware host filtering for a resolved catalog. Curated state probes are
 * admission signals for the built-in definition only: a user/registry winner
 * with the same id keeps the pre-curated command-probe behaviour.
 */
export function installedRuntimeCatalog(
  catalog: ResolvedRuntimeCatalog,
  env: NodeJS.ProcessEnv = process.env
): ResolvedRuntimeCatalog {
  const runtimes: Record<string, RuntimeDef> = {}
  const entries: ResolvedRuntimeCatalog['entries'] = {}
  for (const [id, entry] of Object.entries(catalog.entries)) {
    // Installable archives can use initialized product state until the store supplies their executable.
    const available = parseArchiveLaunch(id, entry)
      ? isCommandAvailable(entry.runtime.command, env) || (CUSTOM_PROBES[id]?.(env) ?? false)
      : entry.source === 'curated' || !CURATED_RUNTIME_IDS.has(id)
        ? isRuntimeAvailable(id, entry.runtime, env)
        : isCommandAvailable(entry.runtime.command, env) && !PACKAGE_LAUNCHERS.has(entry.runtime.command)
    if (!available) continue
    runtimes[id] = entry.runtime
    entries[id] = entry
  }
  return { entries, runtimes }
}
