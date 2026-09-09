// Run with tsx: smoke-microsandbox-docker.mts <image> <msb-binary> [sdk-module] [cache-dir] [guest-helper].
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, statfs, symlink, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { MicrosandboxManager, type MicrosandboxEnvironment } from '../src/microsandbox/driver.js'
import { MICROSANDBOX_GUEST_ENTRY } from '../src/microsandbox/guest.js'

const [image, msbBinary, sdkModule, cacheDir, helperArgument] = process.argv.slice(2)
if (!image || !msbBinary)
  throw new Error('usage: smoke-microsandbox-docker.mts <image> <msb-binary> [sdk-module] [cache-dir] [guest-helper]')
const root = await mkdtemp(join(tmpdir(), 'acd-'))
const helper = resolve(helperArgument ?? fileURLToPath(new URL('../dist/microsandbox/guest.js', import.meta.url)))
const home = join(root, 'home')
await mkdir(home)
await mkdir(join(root, 'microsandbox'))
if (cacheDir) await symlink(resolve(cacheDir), join(root, 'microsandbox', 'cache'))
const sandboxEnv = {
  PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
  HOME: home,
  MSB_HOME: join(root, 'microsandbox'),
  MSB_BACKEND: 'local',
  XDG_CACHE_HOME: join(root, 'cache')
}
// Preserve Node's environment proxy so native SDK calls see the same values as child processes.
for (const key of Object.keys(process.env)) {
  if (!Object.hasOwn(sandboxEnv, key)) delete process.env[key]
}
Object.assign(process.env, sandboxEnv)
const sdk: typeof import('microsandbox') = await import(
  sdkModule ? pathToFileURL(resolve(sdkModule)).href : 'microsandbox'
)
const sockets = { mcp: join(root, 'mcp.sock'), gitcred: join(root, 'git.sock') }
const servers: Server[] = []
for (const path of Object.values(sockets)) {
  const server = createServer((socket) => socket.end())
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(path, resolve)
  })
  servers.push(server)
}
const manager = new MicrosandboxManager({
  root,
  sdk,
  sockets,
  msbCommand: { command: resolve(msbBinary), args: [] },
  config: { image, cpus: 2, memoryMiB: 2048, diskGiB: 8 },
  log: { info: console.log, warn: console.warn, error: console.error, debug: () => {}, trace: () => {} }
})
const environments: MicrosandboxEnvironment[] = []
const env = {
  HOME: '/agent',
  PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  DOCKER_HOST: 'unix:///var/run/docker.sock'
}
const imageName = 'ac-docker-smoke:local'
const volumeName = 'ac-docker-smoke-data'
const step = (name: string, detail: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ step: name, ...detail }))
async function freeBytes() {
  const disk = await statfs(root)
  return disk.bavail * disk.bsize
}
async function run(environment: MicrosandboxEnvironment, command: string, args: string[]) {
  const result = await manager.exec(environment, command, args, {
    cwd: environment.workspaceRoot,
    env,
    timeoutMs: 180_000
  })
  assert.equal(result.exitCode, 0, `${command} ${args.join(' ')}: ${result.stderr}`)
  return result.stdout.trim()
}
async function startDocker(environment: MicrosandboxEnvironment) {
  const cold = await manager.exec(environment, '/usr/bin/docker', ['info'], {
    cwd: environment.workspaceRoot,
    env
  })
  assert.notEqual(cold.exitCode, 0, 'Docker started without the agent requesting it')
  await run(environment, '/usr/bin/sudo', ['-n', '/usr/bin/dockerd', '--version'])
  await run(environment, '/bin/sh', ['-c', 'sudo -n /usr/bin/dockerd > /tmp/dockerd.log 2>&1 < /dev/null &'])
  const deadline = Date.now() + 60_000
  for (;;) {
    const ready = await manager.exec(environment, '/usr/bin/docker', ['info', '--format', '{{.ServerVersion}}'], {
      cwd: environment.workspaceRoot,
      env
    })
    if (ready.exitCode === 0) return ready.stdout.trim()
    if (Date.now() >= deadline) throw new Error(await run(environment, '/usr/bin/tail', ['-60', '/tmp/dockerd.log']))
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}
async function session(name: string) {
  const workspace = join(root, name)
  await mkdir(workspace)
  const environment: MicrosandboxEnvironment = {
    id: `docker-smoke/${name}`,
    workspaceRoot: workspace,
    mounts: [
      { source: workspace, target: workspace, readOnly: false },
      { source: helper, target: MICROSANDBOX_GUEST_ENTRY, readOnly: true }
    ]
  }
  environments.push(environment)
  return environment
}
let passed = false
try {
  step('start', { root })
  await manager.prepare()
  const beforeFirst = await freeBytes()
  const first = await session('first')
  assert.equal(await run(first, '/usr/bin/id', ['-u']), '10001')
  step('runtime-user', { identity: await run(first, '/usr/bin/id', []) })
  const version = await startDocker(first)
  step('docker-manually-started-as-runtime-user', { version })
  await writeFile(
    join(first.workspaceRoot, 'Dockerfile'),
    'FROM busybox:1.37.0\nRUN mkdir /www && printf COMPOSE_OK > /www/index.html\n'
  )
  await writeFile(
    join(first.workspaceRoot, 'compose.yaml'),
    `services:
  web:
    build: .
    image: ${imageName}
    command: [sh, -c, "echo SESSION_A > /cache/marker; httpd -f -p 8080 -h /www"]
    volumes: [data:/cache]
    healthcheck:
      test: [CMD, wget, -qO-, http://localhost:8080]
      interval: 1s
      timeout: 3s
      retries: 30
  check:
    image: busybox:1.37.0
    depends_on:
      web: {condition: service_healthy}
    command: [sh, -c, 'test "$(wget -qO- http://web:8080)" = COMPOSE_OK']
volumes:
  data: {name: ${volumeName}}
`
  )
  await run(first, '/usr/bin/docker', [
    'compose',
    'up',
    '--build',
    '--abort-on-container-exit',
    '--exit-code-from',
    'check'
  ])
  await run(first, '/usr/bin/docker', ['compose', 'down'])
  const built = await run(first, '/usr/bin/docker', ['image', 'inspect', imageName, '--format', '{{.Id}}'])
  await run(first, '/usr/bin/docker', [
    'run',
    '--rm',
    '--user',
    '10001:10001',
    '-v',
    `${first.workspaceRoot}:/work`,
    'busybox:1.37.0',
    'sh',
    '-c',
    'echo BIND_OK > /work/container-marker'
  ])
  assert.equal((await readFile(join(first.workspaceRoot, 'container-marker'), 'utf8')).trim(), 'BIND_OK')
  step('compose-build-service-dns-and-workspace-bind-passed')
  await manager.suspend(first.id)
  const remaining = await freeBytes()
  const firstAllocation = Math.max(0, beforeFirst - remaining)
  assert.ok(remaining - firstAllocation >= 2 * 1024 ** 3, 'second VM would leave less than 2 GiB free')
  const second = await session('second')
  await startDocker(second)
  const absent = await manager.exec(second, '/usr/bin/docker', ['image', 'inspect', imageName], {
    cwd: second.workspaceRoot,
    env
  })
  assert.notEqual(absent.exitCode, 0, 'second session inherited the first session image')
  assert.equal(await run(second, '/usr/bin/docker', ['volume', 'ls', '--format', '{{.Name}}']), '')
  await run(second, '/usr/bin/docker', [
    'run',
    '--rm',
    '-v',
    `${volumeName}:/cache`,
    'busybox:1.37.0',
    'sh',
    '-c',
    'echo SESSION_B > /cache/marker'
  ])
  await startDocker(first)
  assert.equal(await run(first, '/usr/bin/docker', ['image', 'inspect', imageName, '--format', '{{.Id}}']), built)
  assert.equal(
    await run(first, '/usr/bin/docker', [
      'run',
      '--rm',
      '-v',
      `${volumeName}:/cache`,
      'busybox:1.37.0',
      'cat',
      '/cache/marker'
    ]),
    'SESSION_A'
  )
  step('two-session-docker-state-isolated-and-retained-after-resume')
  for (const [environment, marker] of [
    [first, 'FIRST'],
    [second, 'SECOND']
  ] as const) {
    await run(environment, '/usr/bin/docker', [
      'run',
      '-d',
      '--name',
      'same-port',
      '-p',
      '18080:8080',
      'busybox:1.37.0',
      'sh',
      '-c',
      `mkdir /www; echo ${marker} > /www/index.html; httpd -f -p 8080 -h /www`
    ])
    assert.equal(
      await run(environment, '/usr/bin/curl', [
        '--retry',
        '10',
        '--retry-connrefused',
        '--retry-delay',
        '1',
        '-fsS',
        'http://127.0.0.1:18080'
      ]),
      marker
    )
  }
  await run(first, '/usr/bin/docker', [
    'run',
    '-d',
    '--name',
    'random-port',
    '-p',
    '8080',
    imageName,
    'httpd',
    '-f',
    '-p',
    '8080',
    '-h',
    '/www'
  ])
  const published = await run(first, '/usr/bin/docker', ['port', 'random-port', '8080/tcp'])
  const randomPort = published.match(/^0\.0\.0\.0:(\d+)/)?.[1]
  assert.ok(randomPort, `missing random published port: ${published}`)
  assert.equal(
    await run(first, '/usr/bin/curl', [
      '--retry',
      '10',
      '--retry-connrefused',
      '--retry-delay',
      '1',
      '-fsS',
      `http://127.0.0.1:${randomPort}`
    ]),
    'COMPOSE_OK'
  )
  step('simultaneous-vm-published-ports-isolated', { samePort: 18080, randomPort })
  await run(first, '/usr/local/bin/npm', [
    'install',
    '--prefix',
    join(first.workspaceRoot, 'testcontainers'),
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    'testcontainers@12.1.0'
  ])
  await writeFile(
    join(first.workspaceRoot, 'testcontainers', 'smoke.mjs'),
    `
import assert from 'node:assert/strict';
import { GenericContainer } from 'testcontainers';
const container = await new GenericContainer('busybox:1.37.0')
  .withCommand(['sh', '-c', 'mkdir /www; echo TESTCONTAINERS_OK > /www/index.html; httpd -f -p 8080 -h /www'])
  .withExposedPorts(8080).start();
try {
  const response = await fetch('http://' + container.getHost() + ':' + container.getMappedPort(8080));
  assert.equal((await response.text()).trim(), 'TESTCONTAINERS_OK');
  console.log(container.getId());
} finally { await container.stop(); }
`
  )
  const testContainerId = await run(first, '/usr/local/bin/node', [
    join(first.workspaceRoot, 'testcontainers', 'smoke.mjs')
  ])
  const removed = await manager.exec(first, '/usr/bin/docker', ['inspect', testContainerId], {
    cwd: first.workspaceRoot,
    env
  })
  assert.notEqual(removed.exitCode, 0, 'Testcontainers left its stopped container behind')
  step('testcontainers-random-port-and-cleanup-passed')
  for (const environment of environments) await manager.discard(environment.id)
  assert.deepEqual(await manager.environmentIds(), [])
  passed = true
  step('discarded-all-session-vms')
} finally {
  for (const environment of environments) await manager.discard(environment.id).catch((error) => console.error(error))
  await manager.stopAll()
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  if (passed) await rm(root, { recursive: true, force: true })
  else console.error(`Inspection files retained at ${root}`)
}
