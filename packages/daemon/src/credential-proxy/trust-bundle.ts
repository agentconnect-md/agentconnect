// A session's own certificate authorities kept in the proxy trust bundle it is pointed at (github-app-git-credentials.md, Phase 2, Trust).
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

/** The variables the proxy points at its bundle, each a file a session may also name for itself. */
export const PROXY_TRUST_VARS = [
  'SSL_CERT_FILE',
  'CURL_CA_BUNDLE',
  'GIT_SSL_CAINFO',
  'REQUESTS_CA_BUNDLE',
  'NODE_EXTRA_CA_CERTS'
] as const

/** The bundle Codex verifies with, which it reads before `SSL_CERT_FILE`. */
export const CODEX_CA_ENV = 'CODEX_CA_CERTIFICATE'

/** A placed session's `{ bundle, files }`: its executor's shim merges them there, where the files are, and strips this before exec. */
export const SESSION_TRUST_ENV = 'AC_SHIM_SESSION_TRUST'

const PEM_CERTIFICATE = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g

/** The distinct files a session's own env names in those variables, the agent env over the runtime's as a launch merges them. */
export function sessionAuthorityFiles(env: Record<string, string>, runtimeEnv: Record<string, string>): string[] {
  const files = PROXY_TRUST_VARS.map((name) => env[name] || runtimeEnv[name]).filter((file): file is string => !!file)
  return [...new Set(files)]
}

/** `base` when the session's files add no certificate, else base plus theirs at a content-keyed path beside it, so sessions with the same authorities share one file. */
export function mergedTrustBundle(base: string, files: readonly string[], warn: (message: string) => void): string {
  if (files.length === 0) return base
  let certificates: string[]
  try {
    certificates = (readFileSync(base, 'utf8').match(PEM_CERTIFICATE) ?? []).map((pem) => pem.trim())
  } catch (error) {
    warn(`credential proxy: cannot read trust bundle ${base} to merge a session's authorities (${String(error)})`)
    return base
  }
  const merged = new Set(certificates)
  for (const file of files) {
    if (file === base) continue
    try {
      for (const pem of readFileSync(file, 'utf8').match(PEM_CERTIFICATE) ?? []) merged.add(pem.trim())
    } catch (error) {
      warn(`credential proxy: skipping a session's authority file ${file} (${String(error)})`)
    }
  }
  if (merged.size === certificates.length) return base
  const content = `${[...merged].join('\n')}\n`
  const digest = createHash('sha256').update(content).digest('hex').slice(0, 16)
  const path = join(dirname(base), `${basename(base, '.pem')}-${digest}.pem`)
  if (existsSync(path)) return path
  try {
    const mode = statSync(base).mode & 0o777
    const temporary = join(dirname(base), `.${randomBytes(6).toString('hex')}.tmp`)
    writeFileSync(temporary, content, { mode, flag: 'wx' })
    chmodSync(temporary, mode)
    renameSync(temporary, path)
    return path
  } catch (error) {
    warn(`credential proxy: cannot write a session's trust bundle beside ${base} (${String(error)})`)
    return base
  }
}

/** On the executor: merge a placed session's authority files into its listener bundle and repoint the variables that still name it; never fails a spawn. */
export function applySessionTrust(env: Record<string, string>, warn: (message: string) => void): void {
  const raw = env[SESSION_TRUST_ENV]
  delete env[SESSION_TRUST_ENV]
  if (!raw) return
  let request: { bundle?: unknown; files?: unknown }
  try {
    request = JSON.parse(raw) as typeof request
  } catch {
    return warn(`acp: ignoring an unreadable ${SESSION_TRUST_ENV}`)
  }
  const { bundle, files } = request ?? {}
  if (typeof bundle !== 'string' || !Array.isArray(files))
    return warn(`acp: ignoring an unreadable ${SESSION_TRUST_ENV}`)
  const merged = mergedTrustBundle(
    bundle,
    files.filter((file): file is string => typeof file === 'string' && file !== ''),
    warn
  )
  for (const name of [...PROXY_TRUST_VARS, CODEX_CA_ENV]) if (env[name] === bundle) env[name] = merged
}
