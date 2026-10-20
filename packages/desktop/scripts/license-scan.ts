// License scan of the desktop release artifacts (design §11): fails on AGPL / FSL / BSL / SSPL / GPL in bundled components.
import { appendFileSync, closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

export type Verdict = 'allowed' | 'forbidden' | 'unknown'

// The families design §11 forbids; BSL means the Business Source License (SPDX BUSL-1.1), not Boost's BSL-1.0.
const FORBIDDEN = [/^A?GPL-/, /^SSPL-/, /^BUSL-/, /^BSL-1\.1$/, /^FSL-/]
// Permissive licenses accepted without review; anything else fails closed until someone adds it here.
const ALLOWED = new Set([
  '0BSD',
  'Apache-2.0',
  'BlueOak-1.0.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'BSL-1.0',
  'CC0-1.0',
  'ISC',
  'MIT',
  'MIT-0',
  'Unlicense',
  'Zlib'
])

// Classifies one SPDX license id (`+` and `-or-later` forms included).
export function classifyId(id: string): Verdict {
  const bare = id.replace(/\+$/, '')
  if (FORBIDDEN.some((pattern) => pattern.test(bare))) return 'forbidden'
  return ALLOWED.has(bare) ? 'allowed' : 'unknown'
}

const RANK: Record<Verdict, number> = { forbidden: 0, unknown: 1, allowed: 2 }
const best = (a: Verdict, b: Verdict): Verdict => (RANK[a] >= RANK[b] ? a : b)
const worst = (a: Verdict, b: Verdict): Verdict => (RANK[a] <= RANK[b] ? a : b)

// Evaluates an SPDX expression: OR takes the best alternative, AND the worst term, WITH keeps its base license.
export function classifyExpression(expression: string): Verdict {
  const tokens = expression.replace(/[()]/g, ' $& ').trim().split(/\s+/).filter(Boolean)
  let index = 0
  const primary = (): Verdict => {
    const token = tokens[index++]
    if (token === undefined) return 'unknown'
    if (token === '(') {
      const inner = or()
      if (tokens[index] === ')') index++
      return inner
    }
    let verdict = classifyId(token)
    if (tokens[index]?.toUpperCase() === 'WITH') index += 2
    if (/^(SEE|UNLICENSED)$/i.test(token)) verdict = 'unknown'
    return verdict
  }
  const and = (): Verdict => {
    let verdict = primary()
    while (tokens[index]?.toUpperCase() === 'AND') {
      index++
      verdict = worst(verdict, primary())
    }
    return verdict
  }
  const or = (): Verdict => {
    let verdict = and()
    while (tokens[index]?.toUpperCase() === 'OR') {
      index++
      verdict = best(verdict, and())
    }
    return verdict
  }
  const verdict = or()
  return index === tokens.length ? verdict : 'unknown'
}

// License texts or comments that name a forbidden family, for code that carries no package.json of its own.
const FORBIDDEN_TEXT: [RegExp, string][] = [
  [/GNU\s+Affero\s+General\s+Public\s+License/i, 'AGPL'],
  [/GNU\s+General\s+Public\s+License/i, 'GPL'],
  [/(?<![A-Za-z])A?GPL[-v]?[123]/, 'GPL'],
  [/Server\s+Side\s+Public\s+License|\bSSPL\b/i, 'SSPL'],
  [/Business\s+Source\s+License|\bBUSL-1\.1\b/i, 'BSL'],
  [/Functional\s+Source\s+License|\bFSL-1\.[01]\b/i, 'FSL']
]

export function forbiddenText(text: string): string[] {
  const found = FORBIDDEN_TEXT.filter(([pattern]) => pattern.test(text)).map(([, family]) => family)
  for (const match of text.matchAll(/SPDX-License-Identifier:\s*([^\n*]+)/g)) {
    if (classifyExpression(match[1]!.trim()) === 'forbidden') found.push(match[1]!.trim())
  }
  return [...new Set(found)]
}

// Non-npm executables a release artifact may carry, matched by path inside the artifacts directory.
const DECLARED_BINARIES: { pattern: RegExp; component: string; license: string }[] = [
  {
    pattern: /(^|\/)AgentConnect Desktop\.app\/Contents\/MacOS\/agentconnect-desktop$/,
    component: 'Node.js (official build, single executable application)',
    license: 'MIT'
  }
]
// Archives that only repackage a directory scanned beside them.
const DECLARED_ARCHIVES: { pattern: RegExp; contents: string }[] = [
  { pattern: /(^|\/)AgentConnect-Desktop-macos-[a-z0-9]+\.zip$/, contents: 'AgentConnect Desktop.app' }
]
// Separate downloads that must never be bundled (ffmpeg is GPL; Cua Driver is pinned and checksummed on the machine).
const SEPARATE_DOWNLOADS = /(^|\/)(ffmpeg|ffprobe|cua-driver)[^/]*$/i

export interface Component {
  name: string
  license: string
  verdict: Verdict
  source: string
}

export interface ScanResult {
  components: Component[]
  violations: string[]
}

interface Metafile {
  inputs: Record<string, unknown>
}

function packageOf(file: string, stopAt: string): { name: string; license: string } | undefined {
  for (let dir = dirname(file); (dir + sep).startsWith(stopAt); dir = dirname(dir)) {
    const manifest = join(dir, 'package.json')
    if (existsSync(manifest)) {
      const json = JSON.parse(readFileSync(manifest, 'utf8')) as {
        name?: string
        version?: string
        license?: string | { type?: string }
        licenses?: { type?: string }[]
      }
      if (!json.name || !json.version) continue
      const license =
        typeof json.license === 'string'
          ? json.license
          : (json.license?.type ?? json.licenses?.map((entry) => entry.type ?? '?').join(' OR ') ?? '')
      return { name: `${json.name}@${json.version}`, license }
    }
    if (dirname(dir) === dir) break
  }
  return undefined
}

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : [path]
  })

const isExecutable = (file: string): boolean => {
  const head = Buffer.alloc(4)
  const fd = openSync(file, 'r')
  try {
    readSync(fd, head, 0, 4, 0)
  } finally {
    closeSync(fd)
  }
  const magic = head.readUInt32BE(0)
  return (
    magic === 0x7f454c46 ||
    [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe].includes(magic) ||
    head.subarray(0, 2).toString('latin1') === 'MZ'
  )
}

// Scans an artifacts directory built by `bundle` / `bundle:macos`; esbuild metafiles in `.meta/` list every bundled input.
export function scanArtifacts(
  artifacts: string,
  { packageRoot, workspaceRoot }: { packageRoot: string; workspaceRoot: string }
): ScanResult {
  const components = new Map<string, Component>()
  const violations: string[] = []
  const add = (component: Component) => {
    if (components.has(component.name)) return
    components.set(component.name, component)
    if (component.verdict === 'forbidden') {
      violations.push(`${component.name}: forbidden license "${component.license}" (${component.source})`)
    } else if (component.verdict === 'unknown') {
      violations.push(
        `${component.name}: license "${component.license || 'none'}" is not on the allowlist (${component.source})`
      )
    }
  }

  const metaDir = join(artifacts, '.meta')
  const metafiles = existsSync(metaDir) ? readdirSync(metaDir).filter((name) => name.endsWith('.json')) : []
  if (metafiles.length === 0) violations.push(`no esbuild metafile in ${metaDir}: nothing was scanned`)
  for (const name of metafiles) {
    const meta = JSON.parse(readFileSync(join(metaDir, name), 'utf8')) as Metafile
    for (const input of Object.keys(meta.inputs)) {
      const file = resolve(packageRoot, input.replace(/^\(disabled\):/, ''))
      if (!existsSync(file)) {
        violations.push(`${input}: bundled input not found on disk, cannot attribute its license`)
        continue
      }
      const owner = packageOf(file, resolve(workspaceRoot) + sep)
      if (!owner) {
        violations.push(`${input}: no package.json owns this bundled input`)
        continue
      }
      add({ ...owner, verdict: classifyExpression(owner.license), source: name.replace(/\.json$/, '') })
    }
  }

  for (const file of walk(artifacts)) {
    const path = relative(artifacts, file).split(sep).join('/')
    if (path.startsWith('.meta/')) continue
    if (SEPARATE_DOWNLOADS.test(path)) {
      violations.push(`${path}: ffmpeg and Cua Driver are separate downloads and must not ship in an artifact`)
      continue
    }
    if (path.endsWith('.LEGAL.txt')) {
      for (const family of forbiddenText(readFileSync(file, 'utf8'))) {
        violations.push(`${path}: bundled legal comments name a forbidden license (${family})`)
      }
      continue
    }
    const archive = DECLARED_ARCHIVES.find((entry) => entry.pattern.test(path))
    if (archive) {
      if (!existsSync(join(dirname(file), archive.contents))) {
        violations.push(`${path}: archive without its scanned contents (${archive.contents}) beside it`)
      }
      continue
    }
    if (/\.(zip|tar|tgz|gz|xz|7z|dmg|pkg|msi)$/i.test(path)) {
      violations.push(`${path}: undeclared archive; its contents cannot be scanned`)
      continue
    }
    if (!isExecutable(file)) continue
    const declared = DECLARED_BINARIES.find((entry) => entry.pattern.test(path))
    if (!declared) {
      violations.push(`${path}: undeclared executable; declare its component and license in license-scan.ts`)
      continue
    }
    add({
      name: declared.component,
      license: declared.license,
      verdict: classifyExpression(declared.license),
      source: path
    })
  }

  return { components: [...components.values()].sort((a, b) => a.name.localeCompare(b.name)), violations }
}

export function report(result: ScanResult): string {
  const rows = result.components.map(
    (component) => `| ${component.name} | ${component.license || '—'} | ${component.verdict} | ${component.source} |`
  )
  const verdict = result.violations.length
    ? `**${result.violations.length} violation(s)**\n\n${result.violations.map((line) => `- ${line}`).join('\n')}`
    : `**Passed**: ${result.components.length} bundled components, none under AGPL / FSL / BSL / SSPL / GPL.`
  return [
    '### Desktop release artifacts: license scan',
    '',
    verdict,
    '',
    '| Component | License | Verdict | Artifact |',
    '| --- | --- | --- | --- |',
    ...rows,
    ''
  ].join('\n')
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { root: { type: 'string' }, workspace: { type: 'string' } }
  })
  const packageRoot = resolve(values.root ?? join(dirname(fileURLToPath(import.meta.url)), '..'))
  const workspaceRoot = resolve(values.workspace ?? join(packageRoot, '..', '..'))
  const result = scanArtifacts(resolve(positionals[0] ?? join(packageRoot, 'bundle')), { packageRoot, workspaceRoot })
  const text = report(result)
  console.log(text)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`)
  if (result.violations.length) process.exitCode = 1
}
