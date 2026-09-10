import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { checkImageConfig, main, parseDockerfile, releaseBase, selectImage, stagesOf } from './verify-runtime-image.mjs'

const script = fileURLToPath(new URL('verify-runtime-image.mjs', import.meta.url))
const realDockerfile = fileURLToPath(new URL('../docker/runtime-sandbox.Dockerfile', import.meta.url))

const POOL_BASE = `registry.example.test/pool:base-1@sha256:${'a'.repeat(64)}`
const FULL_BASE = `registry.example.test/full:base-1@sha256:${'b'.repeat(64)}`

// Shaped like the release Dockerfile: pinned ARG defaults, builder stages, table checks, release stages, verify stages.
const fixture = ({ pool = POOL_BASE, full = FULL_BASE, releaseExtra = '' } = {}) => `# syntax=docker/dockerfile:1.7

ARG RUNTIME_SANDBOX_BASE=${pool}
ARG RUNTIME_SANDBOX_FULL_BASE=${full}

FROM node:24-slim AS shim-builder
WORKDIR /build
ENV PNPM_HOME=/pnpm \\
  PATH=/pnpm:$PATH
RUN corepack enable

FROM shim-builder AS runtime-helpers
RUN mkdir -p /out/shim

FROM \${RUNTIME_SANDBOX_FULL_BASE} AS runtime-sandbox-full-table-check
RUN node /tmp/check.mjs

# The release images.
FROM \${RUNTIME_SANDBOX_FULL_BASE} AS runtime-sandbox-full
COPY --link --from=runtime-helpers --chown=0:0 \\
  # a comment inside the continuation
  /out/ /opt/agentconnect/
${releaseExtra}
FROM \${RUNTIME_SANDBOX_BASE} AS runtime-sandbox
COPY --link --from=runtime-helpers --chown=0:0 /out/ /opt/agentconnect/

FROM runtime-sandbox AS runtime-sandbox-verify
COPY --from=runtime-sandbox-full-table-check /tmp/ok /tmp/ok
USER root
RUN node /tmp/verify.mjs

FROM runtime-sandbox
`

const goodConfig = () => ({
  User: '10001:10001',
  Env: [
    'PATH=/usr/local/bin:/usr/bin:/bin',
    'HOME=/agent',
    'AGENT_BROWSER_EXECUTABLE_PATH=/opt/agentconnect/browser/chrome'
  ],
  Entrypoint: ['/usr/bin/tini', '--', 'node', '/opt/agentconnect/shim/index.js'],
  WorkingDir: '/agent'
})

const inspected = (config = goodConfig()) => ({
  architecture: 'amd64',
  os: 'linux',
  config,
  rootfs: { type: 'layers' }
})

function run(argv, inspect) {
  let stdout = ''
  let stderr = ''
  const calls = []
  const code = main(argv, {
    stdout: { write: (text) => (stdout += text) },
    stderr: { write: (text) => (stderr += text) },
    inspect: (ref) => {
      calls.push(ref)
      return inspect(ref)
    }
  })
  return { code, stdout, stderr, calls }
}

function withDockerfile(t, text) {
  const dir = mkdtempSync(join(tmpdir(), 'ac-verify-image-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'Dockerfile')
  writeFileSync(path, text)
  return { dir, path }
}

test('continuation lines are joined, comments and blank lines dropped, instructions upper-cased', () => {
  const parsed = parseDockerfile(fixture())
  const copy = parsed.find((entry) => entry.instruction === 'COPY' && entry.argument.includes('--link'))
  assert.equal(copy.argument, '--link --from=runtime-helpers --chown=0:0 /out/ /opt/agentconnect/')
  const env = parsed.find((entry) => entry.instruction === 'ENV')
  assert.equal(env.argument, 'PNPM_HOME=/pnpm PATH=/pnpm:$PATH')
  assert.equal(parsed.filter((entry) => entry.instruction.startsWith('#')).length, 0)
  assert.equal(parsed.filter((entry) => entry.instruction === 'FROM').length, 7)
})

test('stages carry their name, FROM reference and instructions; global ARG defaults are collected', () => {
  const { globalArgs, stages } = stagesOf(parseDockerfile(fixture()))
  assert.deepEqual(
    [...globalArgs],
    [
      ['RUNTIME_SANDBOX_BASE', POOL_BASE],
      ['RUNTIME_SANDBOX_FULL_BASE', FULL_BASE]
    ]
  )
  const release = stages.find((stage) => stage.name === 'runtime-sandbox')
  assert.equal(release.from, '${RUNTIME_SANDBOX_BASE}')
  assert.deepEqual(
    release.instructions.map((entry) => entry.instruction),
    ['COPY']
  )
  const last = stages[stages.length - 1]
  assert.deepEqual({ name: last.name, from: last.from }, { name: undefined, from: 'runtime-sandbox' })
})

test('each release stage resolves to its own pinned base', () => {
  assert.equal(releaseBase(fixture(), 'runtime-sandbox').base, POOL_BASE)
  assert.equal(releaseBase(fixture(), 'runtime-sandbox').arg, 'RUNTIME_SANDBOX_BASE')
  assert.equal(releaseBase(fixture(), 'runtime-sandbox-full').base, FULL_BASE)
  assert.equal(releaseBase(fixture(), 'runtime-sandbox-full').arg, 'RUNTIME_SANDBOX_FULL_BASE')
})

test('a --build-arg override replaces the default and may name a tag, while the default must be digest-pinned', () => {
  const tag = 'registry.example.test/pool:base-2'
  assert.equal(releaseBase(fixture(), 'runtime-sandbox', { RUNTIME_SANDBOX_BASE: tag }).base, tag)
  assert.equal(releaseBase(fixture(), 'runtime-sandbox-full', { RUNTIME_SANDBOX_BASE: tag }).base, FULL_BASE)
  assert.throws(
    () => releaseBase(fixture({ pool: 'registry.example.test/pool:base-2' }), 'runtime-sandbox'),
    /RUNTIME_SANDBOX_BASE defaults to registry.example.test\/pool:base-2, which is not digest-pinned/
  )
})

test('a release stage that writes image config, or builds on another stage, is refused', () => {
  assert.throws(
    () => releaseBase(fixture({ releaseExtra: 'ENV HOME=/elsewhere\nUSER root\n' }), 'runtime-sandbox-full'),
    /runtime-sandbox-full writes image config of its own \(ENV, USER\)/
  )
  assert.throws(
    () => releaseBase(fixture({ releaseExtra: 'WORKDIR /tmp\n' }), 'runtime-sandbox-full'),
    /writes image config of its own \(WORKDIR\)/
  )
  // RUN, COPY, ADD and LABEL touch the filesystem or the labels, never USER, ENTRYPOINT or ENV.
  assert.doesNotThrow(() =>
    releaseBase(fixture({ releaseExtra: 'RUN chmod 0555 /opt/agentconnect\nLABEL a=b\n' }), 'runtime-sandbox-full')
  )
  assert.throws(
    () => releaseBase(fixture(), 'runtime-sandbox-verify'),
    /builds FROM runtime-sandbox rather than directly/
  )
  assert.throws(() => releaseBase(fixture(), 'runtime-sandbox-smoke'), /no stage named runtime-sandbox-smoke/)
})

test('the repository Dockerfile passes the stage assertions for both variants', () => {
  const text = readFileSync(realDockerfile, 'utf8')
  for (const variant of ['runtime-sandbox', 'runtime-sandbox-full']) {
    const { base, stage } = releaseBase(text, variant)
    assert.match(base, /^ghcr\.io\/[^@]+@sha256:[0-9a-f]{64}$/)
    assert.deepEqual(
      stage.instructions.map((entry) => entry.instruction),
      ['COPY']
    )
  }
})

test('a single image or a per-platform map both yield the platform image', () => {
  assert.equal(selectImage(inspected(), 'linux/amd64').config.User, '10001:10001')
  const multi = { 'linux/amd64': inspected(), 'linux/arm64': inspected({ ...goodConfig(), User: 'other' }) }
  assert.equal(selectImage(multi, 'linux/amd64').config.User, '10001:10001')
  assert.equal(selectImage(multi, 'linux/arm64').config.User, 'other')
  assert.throws(() => selectImage(multi, 'linux/386'), /no linux\/386 image/)
  assert.throws(() => selectImage(null, 'linux/amd64'), /no linux\/amd64 image/)
})

test('the config assertions name what they proved and fail on root, a foreign entrypoint or a missing browser env', () => {
  const notes = checkImageConfig(goodConfig())
  assert.equal(notes.length, 3)
  assert.match(notes[0], /USER 10001:10001/)
  assert.match(notes[1], /tini/)
  assert.match(notes[2], /AGENT_BROWSER_EXECUTABLE_PATH=\/opt\/agentconnect\/browser\/chrome/)
  assert.throws(() => checkImageConfig({ ...goodConfig(), User: '' }), /no USER is set/)
  assert.throws(() => checkImageConfig({ ...goodConfig(), User: 'root' }), /USER is root/)
  assert.throws(() => checkImageConfig({ ...goodConfig(), User: '0:0' }), /USER is 0:0/)
  assert.throws(() => checkImageConfig({ ...goodConfig(), Entrypoint: ['node', 'index.js'] }), /entrypoint is not tini/)
  assert.throws(() => checkImageConfig({ ...goodConfig(), Entrypoint: undefined }), /entrypoint is not tini: null/)
  assert.throws(
    () => checkImageConfig({ ...goodConfig(), Env: ['HOME=/agent', 'AGENT_BROWSER_EXECUTABLE_PATH='] }),
    /AGENT_BROWSER_EXECUTABLE_PATH is unset/
  )
  assert.doesNotThrow(() => checkImageConfig({ ...goodConfig(), Entrypoint: ['tini', '--'] }))
})

test('main inspects exactly the pinned base of the variant and reports every check', (t) => {
  const { path } = withDockerfile(t, fixture())
  const good = run(['runtime-sandbox-full', '--dockerfile', path], () => inspected())
  assert.equal(good.code, 0, good.stderr)
  assert.deepEqual(good.calls, [FULL_BASE])
  assert.match(
    good.stdout,
    /runtime-sandbox-full stage builds directly on \$\{RUNTIME_SANDBOX_FULL_BASE\} and runs only COPY/
  )
  assert.match(good.stdout, /✓ base registry.example.test\/full:base-1@sha256:b+\n/)
  assert.match(good.stdout, /✓ a non-root USER is configured/)
  assert.match(good.stdout, /✓ tini is PID 1/)
  assert.match(good.stdout, /✓ agent-browser is pointed at the baked Chrome/)
  assert.equal(good.stderr, '')
})

test('main honours --build-arg and --platform, and fails on a bad config without hiding what passed', (t) => {
  const { path } = withDockerfile(t, fixture())
  const tag = 'registry.example.test/pool:base-candidate'
  const multi = { 'linux/amd64': inspected({ ...goodConfig(), User: 'root' }), 'linux/arm64': inspected() }
  const bad = run(['runtime-sandbox', '--dockerfile', path, '--build-arg', `RUNTIME_SANDBOX_BASE=${tag}`], () => multi)
  assert.equal(bad.code, 1)
  assert.deepEqual(bad.calls, [tag])
  assert.match(bad.stdout, /✓ the runtime-sandbox stage builds directly on/)
  assert.match(bad.stderr, /✗ USER is root/)
  const arm = run(
    [
      'runtime-sandbox',
      '--dockerfile',
      path,
      '--build-arg',
      `RUNTIME_SANDBOX_BASE=${tag}`,
      '--platform',
      'linux/arm64'
    ],
    () => multi
  )
  assert.equal(arm.code, 0, arm.stderr)
})

test('main refuses a Dockerfile whose release stage writes config before touching the registry', (t) => {
  const { path } = withDockerfile(t, fixture({ releaseExtra: 'ENTRYPOINT ["/bin/sh"]\n' }))
  const result = run(['runtime-sandbox-full', '--dockerfile', path], () => {
    throw new Error('the registry must not be consulted')
  })
  assert.equal(result.code, 1)
  assert.deepEqual(result.calls, [])
  assert.match(result.stderr, /writes image config of its own \(ENTRYPOINT\)/)
})

test('usage errors exit 2', () => {
  assert.equal(run([], () => inspected()).code, 2)
  assert.equal(run(['daemon'], () => inspected()).code, 2)
  assert.equal(run(['runtime-sandbox', '--build-arg', 'NOEQUALS'], () => inspected()).code, 2)
  assert.equal(run(['runtime-sandbox', '--bogus'], () => inspected()).code, 2)
})

// The CLI end to end with a fake docker on PATH, the way the workflow calls it: the imagetools inspect arguments are the
// contract with buildx, so they are asserted rather than mocked past.
test(
  'the CLI asks imagetools for the base image and exits 0 on a good config',
  { skip: process.platform === 'win32' },
  (t) => {
    const { dir, path } = withDockerfile(t, fixture())
    const bin = join(dir, 'bin')
    mkdirSync(bin)
    writeFileSync(
      join(bin, 'docker'),
      [
        '#!/bin/sh',
        'printf "%s\\n" "$*" >> "$FAKE_LOG"',
        '[ "$1 $2 $3" = "buildx imagetools inspect" ] || { echo "unexpected docker call: $*" >&2; exit 64; }',
        '[ "$5 $6" = "--format {{json .Image}}" ] || { echo "unexpected format: $*" >&2; exit 64; }',
        `cat <<'EOF'`,
        JSON.stringify(inspected()),
        'EOF',
        ''
      ].join('\n'),
      { mode: 0o755 }
    )
    const log = join(dir, 'calls.log')
    const result = spawnSync(process.execPath, [script, 'runtime-sandbox', '--dockerfile', path], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_LOG: log }
    })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(readFileSync(log, 'utf8'), `buildx imagetools inspect ${POOL_BASE} --format {{json .Image}}\n`)
    assert.match(result.stdout, /✓ a non-root USER is configured — USER 10001:10001/)
  }
)
