#!/usr/bin/env node
// Answers: does the pnpm-lock.yaml diff between two git revisions change the
// RESOLVED DEPENDENCY CLOSURE of the given workspace importers?
//
//   node scripts/lockfile-closure-changed.mjs <base-rev> <head-rev> <importer-dir>...
//   → prints "changed" or "unchanged"
//
// Why: the lockfile is one file shared by every workspace package, so "did
// pnpm-lock.yaml change" over-triggers change detection badly — bumping an
// icons lib in packages/web rewrites the lockfile and, before this check,
// republished the daemon. Instead of diffing the whole file, walk the v9
// lockfile graph (importers → snapshots → packages) starting from the given
// importer dirs and compare only that subgraph, plus the global knobs
// (overrides / patches / settings / pnpmfile checksum) that can rewrite any
// resolution. Other packages' dependency churn no longer counts as a change.
//
// Safety contract: this must never claim "unchanged" out of confusion — a
// wrong skip silently ships stale bits. Anything the walk doesn't understand
// (future lockfile version, alias/file specs, a workspace link pointing
// outside the given importer set — i.e. the caller's importer list went
// stale) degrades to "changed", which just restores the caller's old
// always-act behavior. A git failure exits non-zero so the caller aborts
// loudly instead of skipping.

import { execFileSync } from 'node:child_process'
import { posix } from 'node:path'
import { pathToFileURL } from 'node:url'

import { parse } from 'yaml'

class UnknownShape extends Error {}

// The subgraph of a v9 lockfile that determines what an install materializes
// for `importerDirs`: their importer blocks verbatim, every reachable
// snapshot entry (dep-path key includes the peer suffix) paired with its
// package entry (tarball integrity, keyed without the suffix), and the
// lockfile-global resolution knobs. Throws UnknownShape rather than guess.
export function relevantClosure(lock, importerDirs) {
  const version = String(lock?.lockfileVersion ?? '')
  if (!version.startsWith('9.')) {
    throw new UnknownShape(`unsupported lockfileVersion '${version}'`)
  }

  const closure = {
    global: {
      settings: lock.settings,
      overrides: lock.overrides,
      patchedDependencies: lock.patchedDependencies,
      pnpmfileChecksum: lock.pnpmfileChecksum
    },
    importers: {},
    snapshots: {}
  }

  const queue = []
  const seen = new Set()
  const enqueue = (name, spec, fromDir) => {
    if (typeof spec !== 'string') throw new UnknownShape(`non-string version for ${name}`)
    if (spec.startsWith('link:')) {
      const target = posix.normalize(posix.join(fromDir ?? '.', spec.slice('link:'.length)))
      if (!importerDirs.includes(target)) {
        throw new UnknownShape(`${name} links to '${target}', which is not in the importer set`)
      }
      return
    }
    const key = `${name}@${spec}`
    if (!seen.has(key)) {
      seen.add(key)
      queue.push(key)
    }
  }

  for (const dir of importerDirs) {
    const importer = lock.importers?.[dir]
    if (!importer) throw new UnknownShape(`importer '${dir}' not in lockfile`)
    closure.importers[dir] = importer
    for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      for (const [name, entry] of Object.entries(importer[section] ?? {})) {
        enqueue(name, entry?.version, dir)
      }
    }
  }

  while (queue.length > 0) {
    const key = queue.pop()
    const snapshot = lock.snapshots?.[key]
    const pkg = lock.packages?.[key.replace(/\(.*$/, '')]
    if (snapshot === undefined || pkg === undefined) {
      throw new UnknownShape(`no snapshot/package entry for '${key}'`)
    }
    closure.snapshots[key] = { snapshot, pkg }
    for (const section of ['dependencies', 'optionalDependencies']) {
      for (const [name, spec] of Object.entries(snapshot[section] ?? {})) {
        enqueue(name, spec)
      }
    }
  }

  return closure
}

// Key order in the lockfile is a serialization detail, not a change.
function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeysDeep(value[key])])
    )
  }
  return value
}

// Never throws for string inputs: anything unparseable or shape-unknown is
// reported as changed (with the reason on stderr).
export function lockfileClosureChanged(baseText, headText, importerDirs) {
  if (baseText === headText) return false
  try {
    const base = JSON.stringify(sortKeysDeep(relevantClosure(parse(baseText), importerDirs)))
    const head = JSON.stringify(sortKeysDeep(relevantClosure(parse(headText), importerDirs)))
    return base !== head
  } catch (error) {
    process.stderr.write(`lockfile-closure-changed: ${error.message} — assuming changed\n`)
    return true
  }
}

function main() {
  const [base, head, ...importerDirs] = process.argv.slice(2)
  if (!base || !head || importerDirs.length === 0) {
    process.stderr.write('usage: lockfile-closure-changed.mjs <base-rev> <head-rev> <importer-dir>...\n')
    process.exit(2)
  }
  const show = (rev) =>
    execFileSync('git', ['show', `${rev}:pnpm-lock.yaml`], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024
    })
  const changed = lockfileClosureChanged(show(base), show(head), importerDirs)
  process.stdout.write(changed ? 'changed\n' : 'unchanged\n')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
