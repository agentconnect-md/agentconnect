#!/usr/bin/env node
// Asserts what the runtime-sandbox image's CONFIG says — a non-root USER, tini as the ENTRYPOINT and the browser path
// ENV — without loading the image. The release stage adds one COPY on top of a digest-pinned base, so the base's config
// IS the image's; this reads the base's config from the registry and, first, checks that the stage writes no config of
// its own. Everything the image's filesystem can answer runs inside the build (docker/runtime-sandbox/verify-image.mjs).
//
//   node scripts/verify-runtime-image.mjs <runtime-sandbox|runtime-sandbox-full> [--build-arg KEY=VALUE]... \
//     [--dockerfile <path>] [--platform <os/arch>]
//
// `--build-arg` names the same base override the build was given, as the manual base bump does; the release build gives
// none, so the Dockerfile's pinned default is what both the build and this check read.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export const VARIANTS = ['runtime-sandbox', 'runtime-sandbox-full']
export const DEFAULT_DOCKERFILE = 'docker/runtime-sandbox.Dockerfile'
export const DEFAULT_PLATFORM = 'linux/amd64'
// Must match SANDBOX_BROWSER_EXECUTABLE_ENV in packages/daemon/src/shim/sandbox-paths.ts.
export const BROWSER_ENV = 'AGENT_BROWSER_EXECUTABLE_PATH'

// Every instruction that writes the image config a pod inherits; one of these in the release stage voids the reasoning.
export const CONFIG_INSTRUCTIONS = new Set([
  'USER',
  'ENTRYPOINT',
  'CMD',
  'ENV',
  'WORKDIR',
  'EXPOSE',
  'VOLUME',
  'STOPSIGNAL',
  'HEALTHCHECK',
  'SHELL',
  'ONBUILD'
])

/** Dockerfile instructions with continuation lines joined and comments dropped, as `{ instruction, argument }`. */
export function parseDockerfile(text) {
  const instructions = []
  let pending = ''
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    // The frontend drops a comment or blank line inside a continued instruction as well.
    if (line === '' || line.startsWith('#')) continue
    if (line.endsWith('\\')) {
      pending += `${line.slice(0, -1).trimEnd()} `
      continue
    }
    const whole = `${pending}${line}`.trim()
    pending = ''
    const match = /^(\S+)\s*([^]*)$/.exec(whole)
    if (match) instructions.push({ instruction: match[1].toUpperCase(), argument: match[2].trim() })
  }
  return instructions
}

/** The global ARG defaults and the stages, each with its FROM reference and the instructions it runs. */
export function stagesOf(instructions) {
  const globalArgs = new Map()
  const stages = []
  for (const { instruction, argument } of instructions) {
    if (instruction === 'FROM') {
      const words = argument.split(/\s+/).filter((word) => !word.startsWith('--'))
      const name = words[1]?.toUpperCase() === 'AS' ? words[2] : undefined
      stages.push({ name, from: words[0] ?? '', instructions: [] })
    } else if (stages.length === 0) {
      if (instruction !== 'ARG') continue
      const match = /^([A-Za-z_][A-Za-z0-9_]*)(?:=(.*))?$/.exec(argument)
      if (match && match[2] !== undefined) globalArgs.set(match[1], match[2].replace(/^"(.*)"$/, '$1'))
    } else {
      stages[stages.length - 1].instructions.push({ instruction, argument })
    }
  }
  return { globalArgs, stages }
}

/** The base ref the variant's release stage builds on, once that stage is shown to leave the base's config alone. */
export function releaseBase(dockerfile, variant, buildArgs = {}) {
  const { globalArgs, stages } = stagesOf(parseDockerfile(dockerfile))
  const stage = stages.find((candidate) => candidate.name === variant)
  if (!stage) throw new Error(`the Dockerfile has no stage named ${variant}`)
  const reference = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(stage.from)
  if (!reference) {
    throw new Error(
      `${variant} builds FROM ${stage.from} rather than directly from a build-arg base, so the base config need not be the image config`
    )
  }
  const arg = reference[1]
  const override = buildArgs[arg]
  const base = override ?? globalArgs.get(arg)
  if (!base) throw new Error(`${arg} has no default in the Dockerfile and no --build-arg`)
  if (override === undefined && !/@sha256:[0-9a-f]{64}$/.test(base)) {
    throw new Error(
      `${arg} defaults to ${base}, which is not digest-pinned, so the base inspected need not be the base built`
    )
  }
  const writes = stage.instructions.filter((entry) => CONFIG_INSTRUCTIONS.has(entry.instruction))
  if (writes.length > 0) {
    const names = [...new Set(writes.map((entry) => entry.instruction))].join(', ')
    throw new Error(`${variant} writes image config of its own (${names}), so the base config is not the image config`)
  }
  return { arg, base, stage }
}

/** `.Image` as imagetools prints it: one image, or one per platform when the base is a multi-platform index. */
export function selectImage(inspected, platform) {
  if (inspected && typeof inspected === 'object' && ('config' in inspected || 'rootfs' in inspected)) return inspected
  const image = inspected?.[platform]
  if (!image || typeof image !== 'object') throw new Error(`the inspected base has no ${platform} image`)
  return image
}

/** The three assertions on an image config; returns one note per check and throws on the first failure. */
export function checkImageConfig(config) {
  const notes = []
  // The verify stage proved its own uid is not 0; this proves a pod without a securityContext inherits that user.
  const user = typeof config?.User === 'string' ? config.User : ''
  if (!user) throw new Error('no USER is set, so the runtime would inherit root')
  if (/^(0|root)(:|$)/.test(user)) throw new Error(`USER is ${user}`)
  notes.push(`a non-root USER is configured — USER ${user}`)
  // PID 1 has to reap the runtime's children and forward SIGTERM, or every drain ends in SIGKILL and looks like a crash.
  const entrypoint = Array.isArray(config.Entrypoint) ? config.Entrypoint : []
  const first = typeof entrypoint[0] === 'string' ? entrypoint[0] : ''
  if (!/(^|\/)tini$/.test(first))
    throw new Error(`entrypoint is not tini: ${JSON.stringify(config.Entrypoint ?? null)}`)
  notes.push(`tini is PID 1 and forwards signals — ${JSON.stringify(entrypoint)}`)
  // With the env unset, agent-browser downloads its own Chrome into the workspace volume and the baked one is dead weight.
  const env = Array.isArray(config.Env) ? config.Env : []
  const declared = env.find((entry) => typeof entry === 'string' && entry.startsWith(`${BROWSER_ENV}=`))
  const path = declared?.slice(BROWSER_ENV.length + 1) ?? ''
  if (!path) throw new Error(`${BROWSER_ENV} is unset, so agent-browser downloads its own Chrome`)
  notes.push(`agent-browser is pointed at the baked Chrome — ${BROWSER_ENV}=${path}`)
  return notes
}

/** The base's image description, as `docker buildx imagetools inspect --format '{{json .Image}}'` prints it. */
export function inspectImage(ref) {
  const out = execFileSync('docker', ['buildx', 'imagetools', 'inspect', ref, '--format', '{{json .Image}}'], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024
  })
  return JSON.parse(out)
}

export function parseArgs(argv) {
  const options = { variant: undefined, buildArgs: {}, dockerfile: DEFAULT_DOCKERFILE, platform: DEFAULT_PLATFORM }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--build-arg') {
      const pair = argv[++i] ?? ''
      const eq = pair.indexOf('=')
      if (eq <= 0) throw new Error(`--build-arg expects KEY=VALUE, got '${pair}'`)
      options.buildArgs[pair.slice(0, eq)] = pair.slice(eq + 1)
    } else if (arg === '--dockerfile' && argv[i + 1]) options.dockerfile = argv[++i]
    else if (arg === '--platform' && argv[i + 1]) options.platform = argv[++i]
    else if (!arg.startsWith('--') && options.variant === undefined) options.variant = arg
    else throw new Error(`unexpected argument '${arg}'`)
  }
  if (!VARIANTS.includes(options.variant)) throw new Error(`variant must be one of ${VARIANTS.join(', ')}`)
  return options
}

export function main(argv, { stdout = process.stdout, stderr = process.stderr, inspect = inspectImage } = {}) {
  const usage = `usage: verify-runtime-image.mjs <${VARIANTS.join('|')}> [--build-arg KEY=VALUE]... [--dockerfile <path>] [--platform <os/arch>]\n`
  let options
  try {
    options = parseArgs(argv)
  } catch (err) {
    stderr.write(`${err.message}\n${usage}`)
    return 2
  }
  const { variant, buildArgs, dockerfile, platform } = options
  const notes = []
  try {
    const { arg, base, stage } = releaseBase(readFileSync(dockerfile, 'utf8'), variant, buildArgs)
    const instructions = stage.instructions.map((entry) => entry.instruction).join(', ') || 'nothing'
    notes.push(
      `the ${variant} stage builds directly on \${${arg}} and runs only ${instructions}, so the base config is the image config`
    )
    notes.push(`base ${base}`)
    notes.push(...checkImageConfig(selectImage(inspect(base), platform).config))
  } catch (err) {
    stdout.write(`${variant} image configuration (${dockerfile})\n${notes.map((note) => `  ✓ ${note}`).join('\n')}\n`)
    stderr.write(`  ✗ ${err.message}\n`)
    return 1
  }
  stdout.write(`${variant} image configuration (${dockerfile})\n${notes.map((note) => `  ✓ ${note}`).join('\n')}\n`)
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)))
}
