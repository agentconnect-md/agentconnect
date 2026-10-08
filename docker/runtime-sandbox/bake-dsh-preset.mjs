#!/usr/bin/env node
// Bake a no-search DeepSeek bundle from the runtime installed in this image.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const target = process.argv[2]
  if (!target) throw new Error('usage: bake-dsh-preset.mjs <output dir>')
  const cacheDir = process.env.DSH_ACP_CACHE_DIR
  if (!cacheDir) throw new Error('DSH_ACP_CACHE_DIR must name the unpacked DeepSeek runtime')
  const composition = bakeRegistryBundle(target, cacheDir)
  process.stderr.write(`dsh preset baked from shipped standard to ${composition}\n`)
}
