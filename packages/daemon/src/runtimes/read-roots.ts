import { closeSync, existsSync, openSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import type { McpServerDef, RuntimeDef } from '../config/config-schema.js'
import { resolveCommandPath } from './probe.js'

/**
 * Read-only code roots that must remain visible after the host HOME (and the
 * AgentConnect daemon root) are hidden.
 *
 * These are capability inputs, not data-directory guesses: callers provide only
 * daemon/registry-owned runtime and MCP definitions. Agent-owned environment and
 * workspace configuration must never participate in command resolution here.
 */
export interface TrustedRuntimeReadRootsOptions {
  runtime: RuntimeDef
  hostEnv?: NodeJS.ProcessEnv
  mcpServers?: readonly McpServerDef[]
  /** Other trusted executables used by descendants (for example node). */
  executableCommands?: readonly string[]
  /** Trusted JS/TS module entries needed by daemon-generated helper shims. */
  moduleEntries?: readonly string[]
  /** Exact daemon-owned files, sockets, or already-reviewed directories. */
  paths?: readonly string[]
  /** Operator-owned daemon-wide read-only host dirs (`security.sandboxReadRoots`), shared by every runtime. */
  readRoots?: readonly string[]
}

function envWith(base: NodeJS.ProcessEnv, entries: readonly { name: string; value: string }[]): NodeJS.ProcessEnv {
  return { ...base, ...Object.fromEntries(entries.map((entry) => [entry.name, entry.value])) }
}

function hostHome(env: NodeJS.ProcessEnv): string {
  return env.HOME || homedir()
}

function expandedAbsolute(path: string, env: NodeJS.ProcessEnv, label: string): string {
  const expanded = path === '~' ? hostHome(env) : path.startsWith('~/') ? join(hostHome(env), path.slice(2)) : path
  if (!isAbsolute(expanded)) throw new Error(`${label} must be absolute: ${path}`)
  return resolve(expanded)
}

function existingRoot(path: string, env: NodeJS.ProcessEnv): string {
  const expanded = expandedAbsolute(path, env, 'trusted runtime read root')
  if (!existsSync(expanded)) throw new Error(`trusted runtime read root does not exist: ${expanded}`)
  return realpathSync(expanded)
}

/** Resolve the existing prefix too, so a missing socket/file below a symlink is
 * still expressed against the path the kernel will see later. */
function canonicalPath(path: string, env: NodeJS.ProcessEnv): string {
  const expanded = expandedAbsolute(path, env, 'trusted runtime read path')
  let current = expanded
  const missing: string[] = []
  for (;;) {
    try {
      return resolve(realpathSync(current), ...missing.reverse())
    } catch {
      const parent = dirname(current)
      if (parent === current) return expanded
      missing.push(basename(current))
      current = parent
    }
  }
}

function contains(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/** Keep the shallowest installation unit. The output is used as a mount policy,
 * so hundreds of redundant package descendants are both slower and harder to
 * audit than one reviewed code-store root. */
export function compactReadRoots(paths: Iterable<string>): string[] {
  const sorted = [...new Set(paths)].sort((a, b) => a.length - b.length || a.localeCompare(b))
  const out: string[] = []
  for (const path of sorted) {
    if (!out.some((root) => contains(root, path))) out.push(path)
  }
  return out
}

function nearestPackageRoot(path: string): string | undefined {
  let current = statSync(path).isDirectory() ? path : dirname(path)
  const filesystemRoot = parse(current).root
  for (;;) {
    if (existsSync(join(current, 'package.json'))) return current
    if (current === filesystemRoot) return undefined
    current = dirname(current)
  }
}

/** Return one auditable JS installation unit instead of recursively emitting
 * every package. pnpm's `.pnpm` directory and a conventional `node_modules`
 * tree contain code, not the user's runtime/session state. */
function nodeInstallationRoot(path: string): string | undefined {
  const parts = resolve(path).split(sep)
  const nodeModules = parts.findIndex((part) => part === 'node_modules')
  if (nodeModules < 0) return undefined
  if (parts[nodeModules + 1] === '.pnpm') return parts.slice(0, nodeModules + 2).join(sep) || sep
  return parts.slice(0, nodeModules + 1).join(sep) || sep
}

function workspaceNodeModules(packageRoot: string): string | undefined {
  let current = packageRoot
  const filesystemRoot = parse(current).root
  for (;;) {
    const candidate = join(current, 'node_modules')
    if (existsSync(candidate)) return realpathSync(candidate)
    if (current === filesystemRoot) return undefined
    current = dirname(current)
  }
}

function pythonVenvRoot(path: string): string | undefined {
  let current = statSync(path).isDirectory() ? path : dirname(path)
  const filesystemRoot = parse(current).root
  for (;;) {
    if (existsSync(join(current, 'pyvenv.cfg'))) return current
    if (current === filesystemRoot) return undefined
    current = dirname(current)
  }
}

function packageEntry(requireFrom: string, name: string): string | undefined {
  const req = createRequire(requireFrom)
  try {
    return req.resolve(`${name}/package.json`)
  } catch {
    try {
      return req.resolve(name)
    } catch {
      return undefined
    }
  }
}

/** Add one source/workspace package and follow only workspace runtime deps. The
 * first dependency that enters node_modules collapses to that installation root;
 * there is no value in walking its manifest dependency-by-dependency. */
function addModulePackage(entry: string, out: Set<string>, visited: Set<string>): void {
  const realEntry = realpathSync(entry)
  const installed = nodeInstallationRoot(realEntry)
  if (installed) {
    out.add(installed)
    return
  }
  const root = nearestPackageRoot(realEntry)
  if (!root || visited.has(root)) return
  visited.add(root)
  out.add(root)
  const nodeModules = workspaceNodeModules(root)
  if (nodeModules) out.add(nodeModules)

  let manifest: { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> }
  try {
    manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as typeof manifest
  } catch {
    return
  }
  const names = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {})
  ])
  for (const name of names) {
    const dependency = packageEntry(join(root, 'package.json'), name)
    if (!dependency) continue
    const dependencyReal = realpathSync(dependency)
    const dependencyInstall = nodeInstallationRoot(dependencyReal)
    if (dependencyInstall) out.add(dependencyInstall)
    else addModulePackage(dependencyReal, out, visited)
  }
}

function shebangCommand(path: string): string | undefined {
  let firstLine: string
  let fd: number | undefined
  try {
    const stat = statSync(path)
    if (!stat.isFile()) return undefined
    fd = openSync(path, 'r')
    const buf = Buffer.alloc(Math.min(512, stat.size))
    readSync(fd, buf, 0, buf.length, 0)
    firstLine = buf.toString('utf8').split(/\r?\n/, 1)[0] ?? ''
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
  if (!firstLine.startsWith('#!')) return undefined
  const words = firstLine.slice(2).trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return undefined
  if (basename(words[0]!) !== 'env') return words[0]
  return words.find((word, index) => index > 0 && !word.startsWith('-'))
}

/** Resolve one daemon/registry-owned executable before the HOME deny is
 * applied. Returning the real path is important for version-manager shims such
 * as ~/.nvm/current: the symlink lives below the hidden HOME, while its target
 * is the installation unit that the sandbox carves back. */
export function resolveTrustedExecutable(command: string, env: NodeJS.ProcessEnv = process.env): string {
  const resolved = resolveCommandPath(command, env)
  if (!resolved) throw new Error(`trusted runtime executable is not available: ${command}`)
  return realpathSync(resolve(resolved))
}

function addExecutable(command: string, env: NodeJS.ProcessEnv, out: Set<string>, executables: Set<string>): void {
  const resolved = resolveCommandPath(command, env)
  if (!resolved) throw new Error(`trusted runtime executable is not available: ${command}`)
  const lexical = resolve(resolved)
  const real = resolveTrustedExecutable(command, env)
  if (executables.has(real)) return
  executables.add(real)

  // Keep the lexical bin directory visible for PATH lookup, then expose the
  // real target's smallest installation unit (package, code store, or venv).
  out.add(dirname(lexical))
  out.add(real)
  const interpreter = shebangCommand(real)
  const installed = nodeInstallationRoot(real)
  if (installed) out.add(installed)
  else if (interpreter) {
    const packageRoot = nearestPackageRoot(real)
    if (packageRoot) out.add(packageRoot)
  }
  const venv = pythonVenvRoot(real)
  if (venv) out.add(venv)

  if (interpreter && interpreter !== command && interpreter !== real) addExecutable(interpreter, env, out, executables)
}

export function trustedRuntimeReadRoots(opts: TrustedRuntimeReadRootsOptions): string[] {
  const hostEnv = opts.hostEnv ?? process.env
  const runtimeEnv = envWith(hostEnv, opts.runtime.env)
  const out = new Set<string>()
  const executables = new Set<string>()
  const packages = new Set<string>()

  addExecutable(opts.runtime.command, runtimeEnv, out, executables)
  for (const path of opts.runtime.readRoots ?? []) out.add(existingRoot(path, runtimeEnv))
  for (const path of opts.readRoots ?? []) out.add(existingRoot(path, hostEnv))

  for (const server of opts.mcpServers ?? []) {
    if (server.transport !== 'stdio' || !server.command) continue
    const serverEnv = envWith(hostEnv, server.env)
    addExecutable(server.command, serverEnv, out, executables)
    for (const path of server.readRoots ?? []) out.add(existingRoot(path, serverEnv))
  }

  for (const command of opts.executableCommands ?? []) addExecutable(command, hostEnv, out, executables)
  for (const entry of opts.moduleEntries ?? []) {
    const path = existingRoot(entry, hostEnv)
    out.add(path)
    addModulePackage(path, out, packages)
  }
  for (const path of opts.paths ?? []) out.add(canonicalPath(path, hostEnv))

  return compactReadRoots(out)
}
