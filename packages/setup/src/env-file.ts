import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { lstat, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises'
import { parseEnv, promisify } from 'node:util'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/
const ENV_ASSIGNMENT = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/
const execFileAsync = promisify(execFile)
const gitEnvironment = {
  PATH: process.env.PATH,
  PATHEXT: process.env.PATHEXT,
  SystemRoot: process.env.SystemRoot,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_OPTIONAL_LOCKS: '0',
  LC_ALL: 'C'
}

function validateKeys(keys: readonly string[]): string[] {
  const unique = [...new Set(keys)]
  const invalid = unique.find((key) => !ENV_KEY.test(key))
  if (invalid) throw new Error(`invalid environment variable name: ${invalid}`)
  return unique
}

async function readSource(path: string): Promise<string> {
  try {
    const existing = await lstat(path)
    if (existing.isSymbolicLink()) throw new Error(`${path} is a symbolic link; refusing to replace it`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  }

  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw new Error(`cannot read ${path}: ${(error as Error).message}`)
  }
}

async function nearestExistingDirectory(path: string): Promise<string> {
  let candidate = dirname(path)
  while (true) {
    try {
      const entry = await lstat(candidate)
      if (entry.isDirectory()) return candidate
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const parent = dirname(candidate)
    if (parent === candidate) return candidate
    candidate = parent
  }
}

async function runGit(directory: string, args: string[]) {
  return execFileAsync('git', ['-c', 'core.fsmonitor=false', '-C', directory, ...args], {
    encoding: 'utf8',
    env: gitEnvironment
  })
}

async function gitMatches(root: string, args: string[]): Promise<boolean> {
  try {
    await runGit(root, args)
    return true
  } catch (error) {
    if ((error as { code?: unknown }).code === 1) return false
    throw new Error('cannot verify whether the environment file is safe for secrets')
  }
}

async function assertSafeSecretSink(path: string): Promise<void> {
  const directory = await nearestExistingDirectory(path)
  const canonicalPath = resolve(await realpath(directory), relative(directory, path))
  let root: string
  try {
    const result = await runGit(directory, ['rev-parse', '--show-toplevel'])
    root = result.stdout.trimEnd()
  } catch (error) {
    const code = (error as { code?: unknown }).code
    const stderr = (error as { stderr?: unknown }).stderr
    if (code === 'ENOENT' || (code === 128 && typeof stderr === 'string' && stderr.includes('not a git repository'))) {
      return
    }
    throw new Error('cannot verify whether the environment file is safe for secrets')
  }

  const pathFromRoot = relative(root, canonicalPath)
  if (!pathFromRoot || pathFromRoot === '..' || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) {
    throw new Error(`${path} is not a safe secret sink`)
  }
  const pathspec = `./${pathFromRoot.split(sep).join('/')}`
  if (await gitMatches(root, ['ls-files', '--error-unmatch', '--', pathspec])) {
    throw new Error(`${path} is tracked by Git; refusing to write secrets`)
  }
  if (!(await gitMatches(root, ['check-ignore', '--quiet', '--', pathspec]))) {
    throw new Error(`${path} is not ignored by Git; refusing to write secrets`)
  }
}

function assertKeysAvailable(path: string, source: string, keys: readonly string[]): void {
  const requested = new Set(keys)
  const conflicts = new Set<string>()
  for (const line of source.split(/\r?\n/)) {
    const key = ENV_ASSIGNMENT.exec(line)?.[1]
    if (key && requested.has(key)) conflicts.add(key)
  }

  if (conflicts.size > 0) {
    throw new Error(`${path} already defines ${[...conflicts].join(', ')}; refusing to overwrite existing values`)
  }
}

export interface EnvFileKeyState {
  absolutePath: string
  defined: string[]
  present: string[]
  missing: string[]
}

function parseEnvSource(path: string, source: string): Record<string, string | undefined> {
  try {
    return parseEnv(source)
  } catch {
    throw new Error(`cannot parse ${path} as an environment file`)
  }
}

export async function inspectEnvFile(path: string, keys: readonly string[]): Promise<EnvFileKeyState> {
  const absolutePath = resolve(path)
  await assertSafeSecretSink(absolutePath)
  const validatedKeys = validateKeys(keys)
  const source = await readSource(absolutePath)
  const values = parseEnvSource(absolutePath, source)
  const defined = new Set<string>()
  for (const line of source.split(/\r?\n/)) {
    const key = ENV_ASSIGNMENT.exec(line)?.[1]
    if (key) defined.add(key)
  }
  return {
    absolutePath,
    defined: validatedKeys.filter((key) => defined.has(key)),
    present: validatedKeys.filter((key) => values[key]?.length),
    missing: validatedKeys.filter((key) => !values[key]?.length)
  }
}

export async function readEnvFileValues(path: string, keys: readonly string[]): Promise<Record<string, string>> {
  const absolutePath = resolve(path)
  await assertSafeSecretSink(absolutePath)
  const validatedKeys = validateKeys(keys)
  const values = parseEnvSource(absolutePath, await readSource(absolutePath))
  return Object.fromEntries(validatedKeys.flatMap((key) => (values[key] === undefined ? [] : [[key, values[key]]])))
}

function renderValue(key: string, value: string): string {
  if (value.includes('\0')) throw new Error(`cannot write ${key}: environment values cannot contain NUL bytes`)
  if (!value.includes("'")) return `${key}='${value}'`
  if (!value.includes('"')) return `${key}="${value}"`
  throw new Error(`cannot write ${key}: environment values containing both quote characters are unsupported`)
}

export async function preflightEnvFile(path: string, keys: readonly string[]): Promise<string> {
  const absolute = resolve(path)
  await assertSafeSecretSink(absolute)
  const validatedKeys = validateKeys(keys)
  assertKeysAvailable(absolute, await readSource(absolute), validatedKeys)
  return absolute
}

export async function writeEnvFile(path: string, values: Readonly<Record<string, string>>): Promise<string> {
  const absolute = resolve(path)
  await assertSafeSecretSink(absolute)
  const entries = Object.entries(values)
  const keys = validateKeys(entries.map(([key]) => key))
  const source = await readSource(absolute)
  assertKeysAvailable(absolute, source, keys)

  const lines = entries.map(([key, value]) => renderValue(key, value))
  const separator = source.length === 0 || source.endsWith('\n') ? '' : '\n'
  const nextSource = `${source}${separator}${lines.join('\n')}${lines.length > 0 ? '\n' : ''}`

  const directory = dirname(absolute)
  await mkdir(directory, { recursive: true })
  const temporary = join(directory, `.${basename(absolute)}.${process.pid}.${randomUUID()}.tmp`)

  try {
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(nextSource, 'utf8')
      await handle.chmod(0o600)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, absolute)
  } catch (error) {
    await unlink(temporary).catch(() => undefined)
    throw new Error(`cannot update ${absolute}: ${(error as Error).message}`)
  }

  return absolute
}
