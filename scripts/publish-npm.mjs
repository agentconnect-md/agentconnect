import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
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

function run(script, args) {
  execFileSync('sh', [script, ...args], { cwd: root, stdio: 'inherit' })
}

export async function publishPackages(tag, { readVersion = readPublishedVersion, execute = run } = {}) {
  const version = tag?.startsWith('v') && semver.valid(tag.slice(1))
  if (!version) throw new Error('Expected a release tag such as v1.2.3 or v1.2.3-rc.1')
  const channel = semver.prerelease(version) ? 'rc' : 'latest'

  for (const component of ['daemon', 'cli', 'setup']) {
    const { name } = JSON.parse(readFileSync(new URL(`../packages/${component}/package.json`, import.meta.url)))
    const [current, existing] = await Promise.all([readVersion(name, channel), readVersion(name, version)])
    if (existing || (current && semver.gte(current, version))) {
      console.log(`${name}@${version}: already published or superseded on ${channel}; skipping`)
      continue
    }

    // Compare with the last successful npm publication, so a failed earlier release cannot hide changed inputs.
    const previousTag = current ? `v${current}` : ''
    const script = `scripts/publish-${component}-if-changed.sh`
    execute(script, [previousTag, version, 'prepare'])
    execute(script, [previousTag, channel, 'publish'])
  }
}

if (import.meta.main) {
  const tag = process.argv[2]
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  if (git('rev-parse', 'HEAD') !== git('rev-parse', '--verify', `${tag}^{commit}`)) {
    throw new Error('The checkout must match the release tag being published')
  }
  await publishPackages(tag)
}
