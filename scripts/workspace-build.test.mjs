import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

test('workspace and standalone builds compile each dependency once, before its consumers', (t) => {
  const fixture = mkdtempSync(join(tmpdir(), 'ac-workspace-build-'))
  t.after(() => rmSync(fixture, { recursive: true, force: true }))
  const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))
  const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value))
  const root = readJson(new URL('../package.json', import.meta.url))
  writeJson(join(fixture, 'package.json'), {
    private: true,
    packageManager: root.packageManager,
    scripts: { build: root.scripts.build }
  })
  writeFileSync(join(fixture, 'pnpm-workspace.yaml'), 'packages: [packages/*]\n')
  const packages = new URL('../packages/', import.meta.url)
  const names = []
  for (const directory of readdirSync(packages)) {
    const pkg = readJson(new URL(`${directory}/package.json`, packages))
    const dependencies = Object.fromEntries(
      Object.entries(pkg.dependencies ?? {}).filter(([, version]) => version.startsWith('workspace:'))
    )
    names.push(pkg.name)
    const path = join(fixture, 'packages', directory)
    mkdirSync(path, { recursive: true })
    writeJson(join(path, 'package.json'), {
      name: pkg.name,
      version: pkg.version,
      dependencies,
      scripts: { build: pkg.scripts.build, 'build:package': 'node ../../record-build.cjs' }
    })
  }
  writeFileSync(
    join(fixture, 'record-build.cjs'),
    `const { existsSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { name, dependencies } = require(join(process.cwd(), 'package.json'))
const output = (name) => join(__dirname, 'built', name.replace('/', '__'))
for (const name of Object.keys(dependencies)) {
  if (!existsSync(output(name))) throw new Error('Dependency not built: ' + name)
}
writeFileSync(output(name), '', { flag: 'wx' })
`
  )
  const built = join(fixture, 'built')
  const run = (cwd) => {
    mkdirSync(built)
    execSync('pnpm run build', {
      cwd,
      env: { ...process.env, pnpm_config_workspace_concurrency: '1' },
      timeout: 60_000,
      stdio: 'pipe'
    })
    const result = readdirSync(built).map((name) => name.replace('__', '/'))
    rmSync(built, { recursive: true })
    return result
  }
  assert.deepEqual(run(fixture).sort(), names.sort())
  assert.deepEqual(run(join(fixture, 'packages', 'daemon')).sort(), [
    '@agentconnect.md/activation-policy',
    '@agentconnect.md/connection',
    '@agentconnect.md/daemon',
    '@agentconnect.md/k8s-client',
    '@agentconnect.md/message',
    '@agentconnect.md/object-store',
    '@agentconnect.md/protocol'
  ])
})
