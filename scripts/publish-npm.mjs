import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import semver from 'semver'

const root = fileURLToPath(new URL('../', import.meta.url))

export async function readPublishedVersion(name, selector) {
  const response = await fetch(
    `https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(selector)}`,
    {
      signal: AbortSignal.timeout(30_000)
    }
  )
  if (response.status === 404) return undefined
  if (!response.ok) throw new Error(`Cannot inspect ${name}@${selector}: registry returned ${response.status}`)
  const { version } = await response.json()
  if (!semver.valid(version)) throw new Error(`Invalid registry version for ${name}@${selector}`)
  return version
}

// The macOS app versions a published computer version pins.
export async function readPublishedPins(name, version) {
  const response = await fetch(
    `https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`,
    { signal: AbortSignal.timeout(30_000) }
  )
  if (!response.ok) throw new Error(`Cannot inspect ${name}@${version}: registry returned ${response.status}`)
  return (await response.json()).optionalDependencies ?? {}
}

const samePins = (a, b) =>
  Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([name, pin]) => b[name] === pin)

function run(script, args) {
  execFileSync('sh', [script, ...args], { cwd: root, stdio: 'inherit' })
}

// Unknown baseline tags count as changed, like the publish-*-if-changed scripts.
function changedSince(tag, paths) {
  try {
    execFileSync('git', ['rev-parse', '-q', '--verify', `${tag}^{commit}`], { cwd: root, stdio: 'ignore' })
  } catch {
    return true
  }
  return (
    execFileSync('git', ['diff', '--name-only', tag, 'HEAD', '--', ...paths], { cwd: root, encoding: 'utf8' }) !== ''
  )
}

// The macOS app: its Info.plist version is in its signature, so a rebuild at an unchanged recipe would cost ad-hoc grants.
const APP_INPUTS = ['packages/computer/scripts/build-macos-app.mjs', 'packages/computer/macos/menubar.swift']
const appBuilt = (arch) =>
  existsSync(new URL(`../packages/computer/bundle/computer-darwin-${arch}/package.json`, import.meta.url))

// Resolve the pinned app before building anything; publication repeats this check against the live registry.
async function planApp(arch, version, channel, { readVersion, changed, buildApps }) {
  const name = `@agentconnect.md/computer-darwin-${arch}`
  const [current, existing] = await Promise.all([readVersion(name, channel), readVersion(name, version)])
  if (existing) return { pin: version, publish: false }
  if (current && (semver.gte(current, version) || !changed(`v${current}`, APP_INPUTS))) {
    return { pin: current, publish: false }
  }
  return buildApps(arch) ? { pin: version, publish: true } : { pin: current, publish: false }
}

function packageChanged(component, previousTag, version) {
  const result = execFileSync('sh', [`scripts/publish-${component}-if-changed.sh`, previousTag, version, 'check'], {
    cwd: root,
    encoding: 'utf8'
  }).trim()
  if (result !== 'changed' && result !== 'unchanged') throw new Error(`Invalid publication check for ${component}`)
  return result === 'changed'
}

export async function planPackages(
  tag,
  {
    readVersion = readPublishedVersion,
    readPins = readPublishedPins,
    changed = changedSince,
    check = packageChanged,
    buildApps = () => true
  } = {}
) {
  const version = tag?.startsWith('v') && semver.valid(tag.slice(1))
  if (!version) throw new Error('Expected a release tag such as v1.2.3 or v1.2.3-rc.1')
  const channel = semver.prerelease(version) ? 'rc' : 'latest'

  const pins = {}
  const apps = []
  for (const arch of ['arm64', 'x64']) {
    const { pin, publish } = await planApp(arch, version, channel, { readVersion, changed, buildApps })
    if (pin) pins[`@agentconnect.md/computer-darwin-${arch}`] = pin
    if (publish) apps.push(arch)
  }

  const packages = []
  for (const component of ['daemon', 'cli', 'setup', 'computer']) {
    const { name } = JSON.parse(readFileSync(new URL(`../packages/${component}/package.json`, import.meta.url)))
    const [current, existing] = await Promise.all([readVersion(name, channel), readVersion(name, version)])
    if (existing || (current && semver.gte(current, version))) continue

    // Compare with the last successful npm publication, so a failed earlier release cannot hide changed inputs.
    const repin = component === 'computer' && current && !samePins(await readPins(name, current), pins)
    const previousTag = current && !repin ? `v${current}` : ''
    if (check(component, previousTag, version)) packages.push({ component, previousTag })
  }
  return { version, channel, apps, packages, pins }
}

export async function publishPackages(tag, { execute = run, built = appBuilt, ...options } = {}) {
  const { version, channel, apps, packages, pins } = await planPackages(tag, { ...options, buildApps: built })
  // The computer package pins each app exactly, so the apps publish first.
  for (const arch of apps) {
    execute('scripts/publish-computer-app.sh', [arch, version, 'prepare'])
    execute('scripts/publish-computer-app.sh', [arch, channel, 'publish'])
  }
  for (const { component, previousTag } of packages) {
    const script = `scripts/publish-${component}-if-changed.sh`
    execute(script, [previousTag, version, 'prepare', ...(component === 'computer' ? [JSON.stringify(pins)] : [])])
    execute(script, [previousTag, channel, 'publish'])
  }
}

if (import.meta.main) {
  const tag = process.argv[2]
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  if (git('rev-parse', 'HEAD') !== git('rev-parse', '--verify', `${tag}^{commit}`)) {
    throw new Error('The checkout must match the release tag being published')
  }
  if (process.argv[3] === '--plan') {
    const { apps, packages } = await planPackages(tag, {
      buildApps: () => process.env.PUBLISH_COMPUTER_MACOS_APP === 'true'
    })
    console.log(`publishNpm=${apps.length > 0 || packages.length > 0}`)
    console.log(`macosArchitectures=${apps.join(' ')}`)
  } else {
    await publishPackages(tag)
  }
}
