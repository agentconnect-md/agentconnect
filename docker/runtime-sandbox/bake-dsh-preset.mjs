#!/usr/bin/env node
// Bakes the DeepSeek Harness agent preset a sandbox seeds into $DSH_HOME: the shipped `standard`
// composition with `web_search` deregistered.
//
//   bake-dsh-preset.mjs <output dir>
//
// Why the tool goes, and why dropping it takes a whole preset: packages/daemon/src/shim/dsh-preset.ts.
// Why the copy is generated here rather than checked in: the only honest source is the `standard` this
// image's PINNED adapter ships, and a vendored copy would rot one adapter bump later.
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** The preset the adapter mounts when a caller names none, and therefore the one to copy. */
const SOURCE_PRESET = 'standard'
/** Where the shipped presets sit inside a dsh installation. */
const SHIPPED_PRESETS = join('config', 'agent-presets')
/** The ACP adapter whose vendored dsh runtime carries those presets when no dsh is installed. */
const ADAPTER_PACKAGE = join('@openma', 'deepseek-harness-acp')

/**
 * Deregister `web_search` in one preset composition, as text.
 *
 * Text and not YAML: a composition may carry `!!js` expressions that only the loader's own dialect
 * parses, and a re-emitted document would drop the comments that explain every row. The edit is
 * asserted rather than attempted — an upstream row this does not recognize fails the build instead
 * of shipping a preset that quietly still has the tool.
 */
export function withSearchDisabled(text) {
  const lines = text.split('\n')
  const rowStarts = lines.flatMap((line, index) => (/^- id: tool-web\s*$/.test(line) ? [index] : []))
  if (rowStarts.length !== 1) throw new Error(`expected exactly one \`- id: tool-web\` row, found ${rowStarts.length}`)
  const start = rowStarts[0]
  // The row body is every following indented line: rows are top-level list items, so the next
  // line starting at column 0 ends this one.
  let end = start + 1
  while (end < lines.length && (lines[end].trim() === '' || /^\s/.test(lines[end]))) end += 1
  // Blank lines between rows belong to neither: a config block appended after them would read as a
  // separate row's stray mapping.
  while (end > start + 1 && lines[end - 1].trim() === '') end -= 1
  const body = lines.slice(start, end)
  const existing = body.findIndex((line) => /^\s+search:/.test(line))
  if (existing !== -1) {
    if (!/^\s+search:\s*false\s*$/.test(body[existing])) {
      throw new Error(`tool-web already sets search (${body[existing].trim()}) — upstream intent changed`)
    }
    return text
  }
  const config = body.findIndex((line) => /^\s+config:\s*$/.test(line))
  const insertAt = config === -1 ? start + body.length : start + config + 1
  const inserted = config === -1 ? ['  config:', '    search: false'] : ['    search: false']
  return [...lines.slice(0, insertAt), ...inserted, ...lines.slice(insertAt)].join('\n')
}

/** Display metadata for the baked preset. `order` is deliberately absent: a copy that sorted into
 *  the shipped set's declared order would stop being distinguishable from its source. */
export function presetMetadata(source) {
  return [
    'name: Standard (no web search)',
    `description: "The shipped ${source} composition with web_search deregistered — a sandbox reaches ` +
      `DeepSeek through the deployment's gateway key, which the search provider's own endpoint rejects."`,
    ''
  ].join('\n')
}

/** The global npm prefix's module root, which is where the Dockerfile installs the runtimes. */
function moduleRoot() {
  const configured = process.env.AC_NODE_MODULES_ROOT
  if (configured) return configured
  return execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim()
}

/**
 * Materialize the shipped preset directory to copy from, into `staging` when it has to be unpacked.
 *
 * Three layouts, because the adapter has shipped dsh in all of them: installed beside it (a
 * deployment that installs the harness itself, which must not be shadowed by an adapter's copy),
 * installed under it as an ordinary dependency (0.4.16), or packed as a vendored archive it unpacks
 * at first run (0.4.26). A real directory wins over the archive either way.
 */
export function presetCandidates(root) {
  const adapter = join(root, ADAPTER_PACKAGE)
  return [
    join(root, '@deepseek-ai', 'dsh', SHIPPED_PRESETS, SOURCE_PRESET),
    join(adapter, 'node_modules', '@deepseek-ai', 'dsh', SHIPPED_PRESETS, SOURCE_PRESET)
  ]
}

function shippedPreset(root, staging) {
  const installed = presetCandidates(root).find((dir) => existsSync(dir))
  if (installed) return installed

  const adapter = join(root, ADAPTER_PACKAGE)
  const manifest = join(adapter, 'vendor', 'runtime.json')
  if (!existsSync(manifest)) {
    throw new Error(`no shipped ${SOURCE_PRESET} preset: tried ${[...presetCandidates(root), manifest].join(', ')}`)
  }
  const archive = join(adapter, 'vendor', JSON.parse(readFileSync(manifest, 'utf8')).archive)
  if (!existsSync(archive)) throw new Error(`vendored runtime manifest names a missing archive: ${archive}`)
  // Only the one preset directory out of a whole node_modules tarball.
  const member = join('node_modules', '@deepseek-ai', 'dsh', SHIPPED_PRESETS, SOURCE_PRESET)
  execFileSync('tar', ['-xzf', archive, '-C', staging, member], { stdio: ['ignore', 'ignore', 'inherit'] })
  const extracted = join(staging, member)
  if (!existsSync(extracted)) throw new Error(`vendored runtime ${archive} ships no ${member}`)
  return extracted
}

/** Copy the shipped preset into `target` and deregister the tool. Returns the composition path. */
export function bakePreset(target, root = moduleRoot()) {
  const staging = mkdtempSync(join(tmpdir(), 'ac-dsh-preset-'))
  try {
    const source = shippedPreset(root, staging)
    rmSync(target, { recursive: true, force: true })
    mkdirSync(target, { recursive: true })
    // The whole directory, not just the composition: a preset's relative plugin files and skill
    // directories travel with it, and a future `standard` may ship some.
    cpSync(source, target, { recursive: true, dereference: true })
    const composition = join(target, 'agent.cordis.yml')
    writeFileSync(composition, withSearchDisabled(readFileSync(composition, 'utf8')))
    writeFileSync(join(target, 'preset.yml'), presetMetadata(SOURCE_PRESET))
    return composition
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const target = process.argv[2]
  if (!target) throw new Error('usage: bake-dsh-preset.mjs <output dir>')
  const composition = bakePreset(target)
  process.stderr.write(`dsh preset baked from shipped ${SOURCE_PRESET} to ${composition}\n`)
}
