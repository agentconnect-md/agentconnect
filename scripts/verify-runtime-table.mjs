#!/usr/bin/env node
// Asserts the runtime table an image ships agrees with a fresh ACP probe of that image and with its declared roster.
//
//   node verify-runtime-table.mjs <variant> <installed-runtimes.json> [k8s-runtimes.json] [generate-runtime-table.mjs]
//
// Runs INSIDE the image, from a build stage whose inputs are the dependency base and the roster it declares: the
// probe spawns every installed runtime for `initialize`, so caching it by those inputs keeps it off the release path.
// Compared on what the image pins, not byte for byte: an option's value roster comes from upstream and drifts alone.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

import { diffRuntimeTables } from './runtime-table-diff.mjs'

export const TABLE_PATH = '/opt/agentconnect/runtime/k8s-runtimes.json'
export const GENERATOR_PATH = '/opt/agentconnect/bin/generate-runtime-table.mjs'

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/** Throws on the first lie the table tells about `variant`; returns the roster drift warnings and a one-line summary. */
export function checkRuntimeTable({ variant, published, probed, expected }) {
  if (!Array.isArray(published?.runtimes) || published.runtimes.length === 0) {
    throw new Error('the table declares no runtimes, so the daemon would advertise none')
  }
  const declaredIds = published.runtimes.map((entry) => entry.id).sort()
  const expectedIds = expected.map((entry) => entry.id).sort()
  if (JSON.stringify(declaredIds) !== JSON.stringify(expectedIds)) {
    throw new Error(`${variant} runtime ids: expected ${expectedIds.join(', ')}, got ${declaredIds.join(', ')}`)
  }
  for (const entry of published.runtimes) {
    const installed = expected.find((runtime) => runtime.id === entry.id)
    if (
      entry.command !== installed.command ||
      JSON.stringify(entry.args ?? []) !== JSON.stringify(installed.args ?? [])
    ) {
      throw new Error(`${entry.id} does not use the executable and arguments declared for ${variant}`)
    }
    if (typeof entry.acp?.protocolVersion !== 'number') {
      throw new Error(`${entry.id} has no ACP protocol version, so the snapshot is not from initialize`)
    }
    if (!isPlainObject(entry.acp.capabilities)) throw new Error(`${entry.id} publishes no ACP capabilities object`)
  }
  const { failures: drift, warnings } = diffRuntimeTables(published, probed)
  // Field by field, because an id@version list once printed two identical strings for the drift it caught.
  if (drift.length > 0) throw new Error(`the shipped table differs from a fresh probe — ${drift.join('; ')}`)
  const summary = published.runtimes
    .map((entry) => `${entry.id}${entry.version ? `@${entry.version}` : ''} acp/${entry.acp.protocolVersion}`)
    .join(' ')
  return { warnings, summary }
}

/** The generator's `-` mode prints the table it would write, so this is the code path the base ran at build time. */
export function probeRuntimeTable(generatorPath = GENERATOR_PATH) {
  const fresh = execFileSync('node', [generatorPath, '-'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  return JSON.parse(fresh)
}

export function main(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  const [variant, expectedPath, tablePath = TABLE_PATH, generatorPath = GENERATOR_PATH] = argv
  if (!['runtime-sandbox', 'runtime-sandbox-full'].includes(variant) || !expectedPath) {
    stderr.write(
      'usage: verify-runtime-table.mjs <runtime-sandbox|runtime-sandbox-full> <installed-runtimes.json> [k8s-runtimes.json] [generate-runtime-table.mjs]\n'
    )
    return 2
  }
  const published = JSON.parse(readFileSync(tablePath, 'utf8'))
  const expected = JSON.parse(readFileSync(expectedPath, 'utf8'))
  let result
  try {
    result = checkRuntimeTable({ variant, published, probed: probeRuntimeTable(generatorPath), expected })
  } catch (err) {
    stderr.write(`  ✗ the published runtime table matches a fresh ACP probe of this image: ${err.message}\n`)
    return 1
  }
  // Reported, never fatal: the image cannot pin these, and failing on them fails a build that changed nothing.
  const lines = [`  ✓ the published runtime table matches a fresh ACP probe of this image — ${result.summary}`]
  for (const warning of result.warnings) lines.push(`  ! ${warning}`)
  stdout.write(`${variant} runtime table check\n${lines.join('\n')}\n`)
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)))
}
