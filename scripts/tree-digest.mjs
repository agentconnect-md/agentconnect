#!/usr/bin/env node
// Content digest of a directory tree: relative paths, entry types, permission bits and bytes — never mtimes or owners.
//
//   node scripts/tree-digest.mjs <dir>   →   sha256:<hex>
//
// The runtime image build runs this over its shim payload (docker/runtime-sandbox.Dockerfile) so build.yaml can alias
// an image whose payload is byte-identical to the previous release's instead of rebuilding it.
import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const sha256 = (data) => createHash('sha256').update(data).digest('hex')

// One manifest line per entry, sorted by UTF-8 byte order (`LC_ALL=C sort`), then hashed as a whole.
export function treeDigest(root) {
  const lines = []
  const visit = (dir) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry)
      const stat = lstatSync(path)
      const mode = (stat.mode & 0o7777).toString(8).padStart(4, '0')
      const rel = relative(root, path).split(sep).join('/')
      if (stat.isDirectory()) {
        lines.push([rel, `d ${mode} - ${rel}`])
        visit(path)
      } else if (stat.isFile()) {
        lines.push([rel, `f ${mode} ${sha256(readFileSync(path))} ${rel}`])
      } else if (stat.isSymbolicLink()) {
        lines.push([rel, `l ${mode} ${sha256(readlinkSync(path))} ${rel}`])
      } else {
        throw new Error(`${rel}: not a regular file, directory or symlink`)
      }
    }
  }
  visit(root)
  lines.sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
  const digest = createHash('sha256')
  for (const [, line] of lines) digest.update(`${line}\n`)
  return `sha256:${digest.digest('hex')}`
}

function main() {
  const [dir, extra] = process.argv.slice(2)
  if (!dir || extra !== undefined) {
    process.stderr.write('usage: tree-digest.mjs <dir>\n')
    process.exit(2)
  }
  process.stdout.write(`${treeDigest(dir)}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
