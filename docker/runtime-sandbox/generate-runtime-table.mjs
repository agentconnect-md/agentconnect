#!/usr/bin/env node
// Generates the declared runtime table from the image it runs inside.
//
// Derived, never hand-written. The table is what the daemon reports in `--cloud` mode instead of
// probing a host, so a hand-maintained one is a claim about the image that nothing checks — and
// the failure is silent: the daemon advertises a runtime version the image does not have, and the
// mismatch surfaces as a confused user rather than a failed build.
//
// Runs at build time (versions come from the installed packages) and again in CI against the
// built image, where the two results are compared.
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Runtime ids this image provides, with the package each one's version is read from. */
const PROVIDED = [
  { id: 'claude-acp', package: '@agentclientprotocol/claude-agent-acp', bin: 'claude-agent-acp' },
  { id: 'codex-acp', package: '@agentclientprotocol/codex-acp', bin: 'codex-acp' }
]

function globalRoot() {
  return execFileSync('npm', ['root', '--global'], { encoding: 'utf8' }).trim()
}

/** The installed version, from the package's own manifest rather than from `--version` output:
 *  a runtime's CLI is free to print whatever it likes, and the manifest is what npm resolved. */
function installedVersion(root, packageName) {
  const manifest = JSON.parse(readFileSync(`${root}/${packageName}/package.json`, 'utf8'))
  if (typeof manifest.version !== 'string' || manifest.version.length === 0) {
    throw new Error(`${packageName} has no version in its manifest`)
  }
  return manifest.version
}

function resolveBin(bin) {
  // Absent means the entry would resolve to nothing at spawn time, which is exactly the drift
  // this generator exists to make impossible.
  return execFileSync('sh', ['-c', `command -v ${bin}`], { encoding: 'utf8' }).trim()
}

export function buildTable() {
  const root = globalRoot()
  return {
    runtimes: PROVIDED.map((entry) => ({
      id: entry.id,
      version: installedVersion(root, entry.package)
    }))
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Written sorted and with a trailing newline so two builds of the same inputs produce the same
  // bytes — a table that differs only in key order would make every image look changed.
  const table = buildTable()
  table.runtimes.sort((a, b) => a.id.localeCompare(b.id))
  const target = process.argv[2]
  if (!target) throw new Error('usage: generate-runtime-table.mjs <output path>')
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, `${JSON.stringify(table, null, 2)}\n`)
  // Resolve every bin now, so a table naming a runtime the image cannot launch fails the BUILD
  // rather than the first session that asks for it.
  for (const entry of PROVIDED) resolveBin(entry.bin)
  process.stdout.write(`runtime table written to ${target}\n`)
}
