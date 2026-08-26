// Guardrail: the published daemon is a single self-contained bundle with zero
// runtime deps (tsdown inlines everything; release.config.js strips
// package.json "dependencies" to {} before publish). If tsdown ever fails to
// inline a workspace/runtime import — e.g. @agentconnect.md/protocol when its
// dist/ wasn't built before tsdown ran — rolldown SILENTLY externalizes it
// (it can't resolve a missing file, so it leaves the bare `import`). With deps
// stripped, that bundle then throws ERR_MODULE_NOT_FOUND on first run.
//
// This check turns that silent degradation into a hard build failure. It runs
// after tsdown in the daemon's `build` script; it ships nowhere (files: ["dist"]).
import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const bundlePath = new URL('../dist/index.js', import.meta.url)
const bundle = readFileSync(bundlePath, 'utf8')

// These packages must be embedded because the published manifest has no runtime
// dependencies. Cover both static imports and the dynamic import used by the
// daemon's hidden, exact-pinned skills CLI entry.
const specs = [
  ...bundle.matchAll(/\bfrom\s*["']([^"']+)["']/g),
  ...bundle.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)
].map((match) => match[1])
const leaked = specs.filter(
  (spec) => spec.startsWith('@agentconnect.md/') || spec === 'skills' || spec.startsWith('skills/')
)

if (leaked.length > 0) {
  const unique = [...new Set(leaked)].sort()
  console.error(
    '✗ daemon bundle is not self-contained — these required imports were left external:\n' +
      unique.map((s) => `    ${s}`).join('\n') +
      '\n  tsdown must inline them. Ensure workspace deps are built before tsdown runs\n' +
      "  (the build's `pnpm --filter '{.}^...' build` step needs `dependencies` intact).\n"
  )
  process.exit(1)
}

const skillsCli = new URL('../dist/skills/dist/cli.js', import.meta.url)
if (!existsSync(skillsCli)) {
  console.error('✗ daemon bundle is missing the separately bundled skills CLI')
  process.exit(1)
}
for (const asset of ['LICENSE', 'ThirdPartyNoticeText.txt', 'workspace-mutation.js']) {
  if (!existsSync(new URL(`../dist/skills/${asset}`, import.meta.url))) {
    console.error(`✗ daemon bundle is missing skills redistribution asset ${asset}`)
    process.exit(1)
  }
}
const version = spawnSync(process.execPath, [fileURLToPath(skillsCli), '--version'], {
  encoding: 'utf8',
  timeout: 10_000,
  env: { PATH: process.env.PATH ?? '' }
})
if (version.status !== 0 || version.stdout.trim() !== '1.5.21') {
  console.error('✗ bundled skills CLI did not report the audited 1.5.21 version')
  process.exit(1)
}

// SRT's native apply-seccomp helper cannot be inlined by tsdown; it must be
// staged beside the bundle for both released Linux arches or the confined skills
// sandbox silently loses Unix-socket blocking at runtime.
for (const arch of ['x64', 'arm64']) {
  if (!existsSync(new URL(`../dist/vendor/seccomp/${arch}/apply-seccomp`, import.meta.url))) {
    console.error(`✗ daemon bundle is missing the SRT apply-seccomp helper for ${arch}`)
    process.exit(1)
  }
}

// The in-sandbox shim is a SEPARATE bundle, and its self-containment is a stronger
// requirement than the daemon's: it ships in the runtime image, so a relative import here
// means the image must also carry the daemon's chunk graph — its CP client, platform SDKs
// and credential paths — into the half-trusted sandbox. One file, or the build fails.
// Every entry the image ships, checked identically: the credential helper and the gh token fetch are separate
// bundles precisely so their graphs stay disjoint from the channel's, and a shared module would show up here
// as a relative chunk import — a file the image never copies.
for (const entry of ['index.js', 'git-credential.js', 'gh-token.js']) {
  const shimPath = new URL(`../dist/shim/${entry}`, import.meta.url)
  if (!existsSync(shimPath)) {
    console.error(`✗ shim bundle ${entry} is missing — \`tsdown --config tsdown.shim.config.ts\` did not run`)
    process.exit(1)
  }
  const shim = readFileSync(shimPath, 'utf8')
  const shimSpecs = [
    ...shim.matchAll(/\bfrom\s*["']([^"']+)["']/g),
    ...shim.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)
  ].map((match) => match[1])
  const shimLeaked = shimSpecs.filter((spec) => !spec.startsWith('node:'))
  if (shimLeaked.length > 0) {
    console.error(
      `✗ shim bundle ${entry} is not self-contained — it imports outside node: builtins:\n` +
        [...new Set(shimLeaked)]
          .sort()
          .map((s) => `    ${s}`)
          .join('\n') +
        '\n  Each entry ships alone in the runtime image, so every dependency must be inlined.\n'
    )
    process.exit(1)
  }
}

const shimSkillsCli = new URL('../dist/shim/skills/dist/cli.js', import.meta.url)
const shimSkillsVersion = spawnSync(process.execPath, [fileURLToPath(shimSkillsCli), '--version'], {
  encoding: 'utf8',
  timeout: 10_000,
  env: { PATH: process.env.PATH ?? '' }
})
if (shimSkillsVersion.status !== 0 || shimSkillsVersion.stdout.trim() !== '1.5.21') {
  console.error('✗ shim skills CLI did not report the audited 1.5.21 version')
  process.exit(1)
}

// The sh wrapper the image puts on the agent's PATH is generated from the same renderGhWrapper the daemon uses,
// so a build that skipped the emit step would ship an image whose `gh` is simply missing.
const ghWrapper = new URL('../dist/shim/gh', import.meta.url)
if (!existsSync(ghWrapper)) {
  console.error('✗ the sandbox gh wrapper is missing — `node scripts/emit-shim-gh-wrapper.mjs` did not run')
  process.exit(1)
}
if (!readFileSync(ghWrapper, 'utf8').includes('/opt/agentconnect/shim/gh-token.js')) {
  console.error('✗ the sandbox gh wrapper does not call the in-image token entry')
  process.exit(1)
}

console.log('✓ daemon bundle is self-contained (including skills CLI 1.5.21 and SRT seccomp helpers)')
console.log('✓ shim bundles are self-contained (channel + credential helper + gh token, node: builtins only)')
