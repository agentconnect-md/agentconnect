// Builds the form-fill browser extension (computer-form-fill-and-vault.md §8): its files in memory, or written with --out <dir>.
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { build } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const extension = join(root, 'extension')
const protocolSource = join(root, '..', 'protocol', 'src', 'computer-form-fill.ts')

// Every source the worker is built from, so the build id changes whenever its behavior can.
function sources() {
  const files = [join(extension, 'manifest.json'), join(extension, 'managed-schema.json'), protocolSource]
  for (const name of readdirSync(join(extension, 'src')).sort())
    if (name.endsWith('.ts') && !name.endsWith('.test.ts')) files.push(join(extension, 'src', name))
  return files
}

/** The extension's files and its build id, which the worker reports in its hello and the daemon expects. */
export async function buildExtension({ version }) {
  const hash = createHash('sha256').update(version)
  for (const file of sources()) hash.update(file.slice(root.length)).update(readFileSync(file))
  const buildId = hash.digest('hex').slice(0, 32)
  const result = await build({
    absWorkingDir: root,
    entryPoints: [join(extension, 'src', 'worker.ts')],
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'esm',
    target: 'chrome116',
    conditions: ['development'],
    // The page functions are serialized into frames; minified names stay inside each function, so they survive.
    minifySyntax: true,
    minifyWhitespace: true,
    define: { __AGENTCONNECT_FORM_FILL_BUILD_ID__: JSON.stringify(buildId) },
    legalComments: 'none',
    logLevel: 'warning'
  })
  // Chromium wants a dotted numeric version; a prerelease suffix is dropped.
  const manifest = JSON.parse(readFileSync(join(extension, 'manifest.json'), 'utf8'))
  manifest.version = /^\d+(\.\d+){0,3}/.exec(version)?.[0] ?? '0.0.0'
  return {
    buildId,
    files: {
      'manifest.json': `${JSON.stringify(manifest, null, 2)}\n`,
      'managed-schema.json': readFileSync(join(extension, 'managed-schema.json'), 'utf8'),
      'worker.js': result.outputFiles[0].text
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { values } = parseArgs({ options: { out: { type: 'string' }, version: { type: 'string' } } })
  const version = values.version ?? JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
  const built = await buildExtension({ version })
  const out = values.out ?? join(root, 'bundle', 'extension')
  mkdirSync(out, { recursive: true })
  for (const [name, text] of Object.entries(built.files)) writeFileSync(join(out, name), text)
  console.log(`form-fill extension ${built.buildId} written to ${out}`)
}
