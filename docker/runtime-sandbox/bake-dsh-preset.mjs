#!/usr/bin/env node
// Bake a no-search DeepSeek preset or bundle from the runtime installed in this image.
import { execFileSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// Copy the preset the adapter mounts when a caller names none.
const SOURCE_PRESET = 'standard'
// dsh 0.1.2 moved the shipped presets from the meta package into the roster package.
const SHIPPED_PRESETS = [
  join('@deepseek-ai', 'dsh', 'config', 'agent-presets', SOURCE_PRESET),
  join('@deepseek-ai', 'dsh-agent-presets', 'presets', SOURCE_PRESET)
]
// The adapter vendors dsh for installations without a separate harness.
const ADAPTER_PACKAGE = join('@openma', 'deepseek-harness-acp')

// Deregister web_search as text so the preset's !!js expressions and comments survive.
export function withSearchDisabled(text) {
  const lines = text.split('\n')
  const rowStarts = lines.flatMap((line, index) =>
    /^(\s*)- id: tool-web\s*$/.test(line) ? [{ index, indent: line.match(/^\s*/)[0] }] : []
  )
  if (rowStarts.length !== 1) throw new Error(`expected exactly one \`- id: tool-web\` row, found ${rowStarts.length}`)
  const { index: start, indent } = rowStarts[0]
  // A row ends at the next line at its indentation or above.
  let end = start + 1
  while (end < lines.length && (lines[end].trim() === '' || lines[end].match(/^\s*/)[0].length > indent.length))
    end += 1
  // Blank lines between rows belong to neither row.
  while (end > start + 1 && lines[end - 1].trim() === '') end -= 1
  const body = lines.slice(start, end)
  const existing = body.findIndex((line) => line.startsWith(`${indent}    search:`))
  if (existing !== -1) {
    if (body[existing].trim() !== 'search: false') {
      throw new Error(`tool-web already sets search (${body[existing].trim()}) — upstream intent changed`)
    }
    return text
  }
  const config = body.findIndex((line) => line === `${indent}  config:`)
  const insertAt = config === -1 ? start + body.length : start + config + 1
  const inserted = config === -1 ? [`${indent}  config:`, `${indent}    search: false`] : [`${indent}    search: false`]
  return [...lines.slice(0, insertAt), ...inserted, ...lines.slice(insertAt)].join('\n')
}

export function bakeRegistryBundle(target, cacheDir) {
  const roots = readdirSync(cacheDir).flatMap((entry) => {
    const modules = join(cacheDir, entry, 'node_modules')
    return existsSync(join(modules, '@deepseek-ai', 'dsh-web-app', 'presets', 'standard.patch.yml')) ? [modules] : []
  })
  if (roots.length !== 1)
    throw new Error(`expected one unpacked DeepSeek runtime in ${cacheDir}, found ${roots.length}`)
  const modules = roots[0]
  const presetRoot = join(modules, '@deepseek-ai', 'dsh-web-app', 'presets')
  const shipped = ['standard', 'ptc', 'minimal', 'cordis'].map((name) =>
    readFileSync(join(presetRoot, `${name}.patch.yml`), 'utf8')
  )
  const source = shipped[0]
  if (source.match(/id: preset-standard\s*$/gm)?.length !== 1 || source.match(/id: standard\s*$/gm)?.length !== 1) {
    throw new Error('the shipped standard preset declaration changed')
  }
  const preset = withSearchDisabled(source)
    .replace('id: preset-standard\n', 'id: preset-standard-no-search\n')
    .replace('id: standard\n', 'id: standard-no-search\n')
  const host = `- insert:\n    - id: subagent-model-selection\n      name: '@deepseek-ai/dsh-tool-subagent/model-selection-settings'\n    - id: agent-preset-registry\n      name: '@deepseek-ai/dsh-agent-preset-registry'\n      config:\n        default: standard-no-search\n`
  rmSync(target, { recursive: true, force: true })
  mkdirSync(target, { recursive: true })
  writeFileSync(
    join(target, 'package.json'),
    JSON.stringify({
      name: '@agentconnect.md/dsh-no-search',
      version: '0.0.0',
      private: true,
      dsh: { bundle: { patch: 'cordis.patch.yml' } }
    }) + '\n'
  )
  writeFileSync(join(target, 'cordis.patch.yml'), `${host}${shipped.join('\n')}${preset}`)
  symlinkSync(modules, join(target, 'node_modules'), 'dir')
  return join(target, 'cordis.patch.yml')
}

// Omit order so the copied preset stays distinct from its source.
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

// Prefer a separately installed harness, then the adapter's nested install, over its vendored archive.
export function presetCandidates(root) {
  return [root, join(root, ADAPTER_PACKAGE, 'node_modules')].flatMap((modules) =>
    SHIPPED_PRESETS.map((preset) => join(modules, preset))
  )
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
  // Match POSIX archive members before extracting only the shipped preset directory.
  const members = new Set(
    execFileSync('tar', ['-tzf', archive], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
      .split('\n')
      .map((member) => member.replace(/^\.\//, '').replace(/\/$/, ''))
  )
  const member = SHIPPED_PRESETS.map((preset) => join('node_modules', preset).replaceAll('\\', '/')).find((candidate) =>
    members.has(`${candidate}/agent.cordis.yml`)
  )
  if (!member) throw new Error(`vendored runtime ${archive} ships no ${SOURCE_PRESET} preset`)
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
    // Preserve the preset's relative plugin files and skill directories.
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
  const composition = process.env.DSH_ACP_CACHE_DIR
    ? bakeRegistryBundle(target, process.env.DSH_ACP_CACHE_DIR)
    : bakePreset(target)
  process.stderr.write(`dsh preset baked from shipped ${SOURCE_PRESET} to ${composition}\n`)
}
