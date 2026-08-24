#!/usr/bin/env node
// Re-vendors the pinned agent-sandbox release manifest into charts/agentconnect.
//   node scripts/vendor-agent-sandbox.mjs vX.Y.Z
// Upstream publishes release manifests but no chart to any registry, so the chart carries
// the manifest instead of depending on one. The upstream document is SPLIT on vendoring:
// the CRDs go to crds/agent-sandbox.yaml, which Helm applies on first install BEFORE it
// resolves any templated custom resource — what lets the default-on daemon pool bootstrap
// a fresh cluster — while the controller stack stays in vendor/agent-sandbox.yaml behind
// the installCRD template switch. The single edit against upstream is
// `helm.sh/resource-policy: keep` on every CRD, matching how the chart treats its own:
// no release uninstall may cascade-delete live Sandboxes. Deterministic — re-running it
// on the same tag is a no-op diff.
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const version = process.argv[2]
if (!version || !/^v\d+\.\d+\.\d+$/.test(version)) {
  process.stderr.write('usage: vendor-agent-sandbox.mjs vX.Y.Z\n')
  process.exit(2)
}

const ASSET = 'sandbox-with-extensions.yaml'
const source = `https://github.com/kubernetes-sigs/agent-sandbox/releases/download/${version}/${ASSET}`
const chart = join(dirname(dirname(fileURLToPath(import.meta.url))), 'charts/agentconnect')
const KEEP = 'helm.sh/resource-policy: keep'

const response = await fetch(source)
if (!response.ok) {
  process.stderr.write(`fetching ${source} failed: ${response.status} ${response.statusText}\n`)
  process.exit(1)
}
const upstream = await response.text()
const digest = createHash('sha256').update(upstream).digest('hex')

// Text-level, one line per CRD: re-serializing 800 KB of generated schema would
// bury the annotation in an unreviewable reformat.
const crds = []
const rest = []
for (const document of upstream.split('\n---\n')) {
  if (!/^kind: CustomResourceDefinition$/m.test(document)) {
    rest.push(document)
    continue
  }
  const lines = document.split('\n')
  const metadata = lines.findIndex((line) => line === 'metadata:')
  if (metadata === -1) throw new Error(`CRD document ${crds.length + 1} has no top-level metadata block`)
  const annotations = lines[metadata + 1] === '  annotations:' ? metadata + 1 : -1
  if (annotations === -1) lines.splice(metadata + 1, 0, '  annotations:', `    ${KEEP}`)
  else lines.splice(annotations + 1, 0, `    ${KEEP}`)
  crds.push(lines.join('\n'))
}
if (crds.length === 0) throw new Error(`${ASSET} contains no CustomResourceDefinition — refusing to vendor it`)

const header = (what) =>
  [
    `# Vendored from ${source}`,
    `# agent-sandbox ${version}, sha256 ${digest} of the upstream asset (${what}).`,
    '#',
    '# Generated from the upstream agent-sandbox release — do not edit by hand; re-run',
    `# scripts/vendor-agent-sandbox.mjs instead. The only change against upstream is the`,
    `# CRD/controller split and \`${KEEP}\` on each of the ${crds.length} CRDs.`,
    ''
  ].join('\n')

writeFileSync(join(chart, 'crds/agent-sandbox.yaml'), header(`the ${crds.length} CRDs`) + crds.join('\n---\n'))
writeFileSync(
  join(chart, 'vendor/agent-sandbox.yaml'),
  header('the controller stack, CRDs split out') + rest.join('\n---\n')
)
process.stdout.write(
  `vendored agent-sandbox ${version}: ${crds.length} CRDs into crds/, controller stack into vendor/\n`
)
