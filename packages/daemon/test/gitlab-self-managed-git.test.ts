/**
 * The self-managed GitLab slice end to end (gitlab-com-integration.md §24.4/§24.5): a REAL git
 * clone and push, and a REAL `glab` invocation, against an instance served on a non-default port
 * behind a path prefix — through the shim, the injected host table, and the operator's TLS bundle.
 *
 * Nothing here is stubbed on the git side: git dials TLS with `GIT_SSL_CAINFO`, `git-http-backend`
 * serves the pack protocol, and the credential helper runs as its own process exactly as git spawns
 * it. That is the point: the config key, `useHttpPath`, the prefix stripping and the project path
 * only agree in real git, and every earlier version of this seam agreed with itself instead.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFile, execFileSync, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer, type Server } from 'node:net'
import { createServer as createTlsServer } from 'node:https'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_WORKSPACE_GIT_ALLOWED_ORIGINS } from '@agentconnect.md/protocol'
import { createRequire } from 'node:module'
import { gitcredSocketPath } from '../src/cp/gitcred-server.js'
import { writeGlabShim } from '../src/cp/glab-shim.js'
import {
  cloneGitEnv,
  gitFor,
  initGitInjection,
  managedCredentialScope,
  workspaceGitEnvBase,
  workspaceGitRemoteTarget
} from '../src/workspace/git-injection.js'
import { configureWorkspaceGitOrigins } from '../src/workspace/git-origin-policy.js'

const AGENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const PROJECT = 'example-group/example-project'
/** The instance's relative URL root — a first-class install shape, and the one that breaks classifiers. */
const PREFIX = 'gitlab'
const TOKEN = 'glpat-effect-token'
const SERVICE_ACCOUNT = 'agent-service-account'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const daemonEntry = join(packageRoot, 'src', 'index.ts')
/** The in-sandbox credential entry: the same helper source, on a graph of three leaf modules. */
const helperEntry = join(packageRoot, 'src', 'shim', 'git-credential.ts')
const tsxCli = createRequire(import.meta.url).resolve('tsx/cli')
// Each shim runs in a fresh node, which resolves workspace siblings from their published `dist`.
// Tests build nothing, so hand the subprocess the same source condition vitest itself uses.
const SOURCE_CONDITION_ENV = { NODE_OPTIONS: '--conditions=development' }

/** `#!/bin/sh` in front of one entry, the way both production shims are shaped. */
function writeEntryShim(path: string, entry: string): string {
  writeFileSync(
    path,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(tsxCli)} ${JSON.stringify(entry)} "$@"\n`,
    {
      mode: 0o755
    }
  )
  chmodSync(path, 0o755)
  return path
}
const gitExecPath = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim()

/** A throwaway self-signed authority for 127.0.0.1 — the operator's bundle, in one file. */
function selfSignedTls(dir: string): { key: string; cert: string; certPath: string } | undefined {
  const keyPath = join(dir, 'instance.key')
  const certPath = join(dir, 'instance.crt')
  try {
    execFileSync(
      'openssl',
      // prettier-ignore
      [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
        '-keyout', keyPath, '-out', certPath, '-days', '2',
        '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'
      ],
      { stdio: 'ignore', timeout: 60_000 }
    )
  } catch {
    return undefined
  }
  return { key: readFileSync(keyPath, 'utf8'), cert: readFileSync(certPath, 'utf8'), certPath }
}

/** `git-http-backend` behind Basic auth, mounted under `/<PREFIX>/` — the fake instance. */
function serveInstance(tls: { key: string; cert: string }, projectRoot: string): Promise<Server & { port: number }> {
  const server = createTlsServer({ key: tls.key, cert: tls.cert }, (req, res) => {
    const expected = `Basic ${Buffer.from(`${SERVICE_ACCOUNT}:${TOKEN}`).toString('base64')}`
    if (req.headers.authorization !== expected) {
      res.writeHead(401, { 'www-authenticate': 'Basic realm="gitlab"' }).end('unauthorized')
      return
    }
    const [rawPath = '', query = ''] = (req.url ?? '').split('?')
    if (!rawPath.startsWith(`/${PREFIX}/`)) {
      res.writeHead(404).end('not this instance')
      return
    }
    const child = spawn(join(gitExecPath, 'git-http-backend'), {
      env: {
        PATH: process.env.PATH ?? '',
        GIT_PROJECT_ROOT: projectRoot,
        GIT_HTTP_EXPORT_ALL: '1',
        REMOTE_USER: SERVICE_ACCOUNT,
        REQUEST_METHOD: req.method ?? 'GET',
        PATH_INFO: rawPath.slice(PREFIX.length + 1),
        QUERY_STRING: query,
        ...(req.headers['content-type'] ? { CONTENT_TYPE: req.headers['content-type'] } : {}),
        ...(req.headers['content-length'] ? { CONTENT_LENGTH: req.headers['content-length'] } : {}),
        ...(req.headers['content-encoding'] ? { HTTP_CONTENT_ENCODING: req.headers['content-encoding'] } : {})
      }
    })
    req.pipe(child.stdin)
    // CGI answers with its own headers, so buffer until the blank line and replay them verbatim.
    const chunks: Buffer[] = []
    let headersSent = false
    child.stdout.on('data', (chunk: Buffer) => {
      if (headersSent) {
        res.write(chunk)
        return
      }
      chunks.push(chunk)
      const buffered = Buffer.concat(chunks)
      const split = buffered.indexOf('\r\n\r\n')
      if (split === -1) return
      headersSent = true
      for (const line of buffered.subarray(0, split).toString('utf8').split('\r\n')) {
        const colon = line.indexOf(':')
        if (colon > 0) res.setHeader(line.slice(0, colon).trim(), line.slice(colon + 1).trim())
      }
      res.write(buffered.subarray(split + 4))
    })
    child.on('close', () => res.end())
  })
  return new Promise((done) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      done(Object.assign(server, { port: typeof address === 'object' && address ? address.port : 0 }))
    })
  })
}

/** The gitcred socket, answering the binding's service-account credential and recording every ask. */
function serveGitcred(path: string): { server: Server; requests: Record<string, unknown>[] } {
  const requests: Record<string, unknown>[] = []
  const server = createServer((conn) => {
    let buf = ''
    conn.on('data', (chunk) => {
      buf += chunk.toString('utf8')
      const nl = buf.indexOf('\n')
      if (nl === -1) return
      const request = JSON.parse(buf.slice(0, nl)) as Record<string, unknown>
      requests.push(request)
      conn.end(
        JSON.stringify({
          ok: true,
          username: SERVICE_ACCOUNT,
          password: TOKEN,
          repoFullName: request.repoFullName ?? PROJECT
        }) + '\n'
      )
    })
  })
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  server.listen(path)
  return { server, requests }
}

/** Local-only git: nothing here reaches the instance, so a blocking call is safe. */
function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@example.test' }
  })
}

// The instance, the gitcred socket and the test all live in ONE process, so every command that has
// to reach one of them must be ASYNC: a synchronous spawn blocks the loop those servers accept on,
// and git then fails with a connection timeout against a server that was never asleep.
const run = promisify(execFile)

const tlsDir = mkdtempSync(join(tmpdir(), 'ac-gl-tls-'))
const tls = selfSignedTls(tlsDir)

describe.skipIf(tls === undefined)('a prefixed, non-default-port instance, end to end (§24.4)', () => {
  let root: string
  let projectRoot: string
  let server: Server & { port: number }
  let gitcred: { server: Server; requests: Record<string, unknown>[] }
  let instance: string
  let cloneUrl: string
  let previousCaInfo: string | undefined

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'ac-gl-daemon-'))
    projectRoot = mkdtempSync(join(tmpdir(), 'ac-gl-projects-'))
    const bare = join(projectRoot, `${PROJECT}.git`)
    mkdirSync(dirname(bare), { recursive: true })
    git(projectRoot, ['init', '--bare', '--initial-branch=main', bare])
    git(projectRoot, ['-C', bare, 'config', 'http.receivepack', 'true'])
    const seed = mkdtempSync(join(tmpdir(), 'ac-gl-seed-'))
    git(seed, ['init', '--initial-branch=main'])
    writeFileSync(join(seed, 'README.md'), 'seeded\n')
    git(seed, ['add', 'README.md'])
    git(seed, ['commit', '-m', 'seed'])
    git(seed, ['push', bare, 'main'])
    rmSync(seed, { recursive: true, force: true })

    server = await serveInstance(tls!, projectRoot)
    instance = `https://127.0.0.1:${server.port}/${PREFIX}`
    cloneUrl = `${instance}/${PROJECT}.git`
    // §24.5: TLS trust is process configuration. Real git verifies the chain through this bundle.
    previousCaInfo = process.env.GIT_SSL_CAINFO
    process.env.GIT_SSL_CAINFO = tls!.certPath
    // The operator's allowlist stays authoritative — the managed feature never widens it.
    configureWorkspaceGitOrigins([`https://127.0.0.1:${server.port}`])
    gitcred = serveGitcred(gitcredSocketPath(root))
    mkdirSync(join(root, 'run'), { recursive: true, mode: 0o700 })
    const helperShim = writeEntryShim(join(root, 'run', 'git-credential'), helperEntry)
    initGitInjection({
      // The daemon's own filesystem, but pointed at the leaf entry and an explicit socket: the same
      // helper source git spawns in production, without the whole daemon graph behind it.
      targetFor: () => ({
        kind: 'daemon',
        helper: helperShim,
        configDir: join(root, 'run', 'gitcred'),
        socketPath: gitcredSocketPath(root)
      }),
      preWarm: async () => undefined,
      capabilityFor: () => 'cap-test'
    })
  }, 120_000)

  afterAll(() => {
    server?.close()
    gitcred?.server.close()
    if (previousCaInfo === undefined) delete process.env.GIT_SSL_CAINFO
    else process.env.GIT_SSL_CAINFO = previousCaInfo
    configureWorkspaceGitOrigins([...DEFAULT_WORKSPACE_GIT_ALLOWED_ORIGINS])
    for (const dir of [root, projectRoot, tlsDir]) if (dir) rmSync(dir, { recursive: true, force: true })
  })

  const scope = () => managedCredentialScope('gitlab', instance)

  it('clones and pushes through the injected helper table, on the instance path prefix', async () => {
    const checkout = join(root, 'checkout')
    const env = { ...workspaceGitEnvBase(cloneUrl), ...cloneGitEnv(AGENT, cloneUrl, scope()), ...SOURCE_CONDITION_ENV }
    // No `process.env` spread: `workspaceGitEnvBase` already IS the sanitized process env, and a
    // raw spread reintroduces exactly the host-shell names simple-git refuses (a login-shell EDITOR).
    await gitFor(root).env(env).clone(cloneUrl, checkout, ['--branch', 'main', '--single-branch'])
    expect(readFileSync(join(checkout, 'README.md'), 'utf8')).toBe('seeded\n')

    writeFileSync(join(checkout, 'agent.txt'), 'written by the agent\n')
    git(checkout, ['add', 'agent.txt'])
    git(checkout, ['commit', '-m', 'agent change'])
    const target = workspaceGitRemoteTarget(cloneUrl, AGENT, scope())
    await run('git', ['push', '--porcelain', target.remote, 'refs/heads/main:refs/heads/main'], {
      cwd: checkout,
      env: { ...target.env, ...SOURCE_CONDITION_ENV }
    })
    const remoteHead = git(projectRoot, ['-C', join(projectRoot, `${PROJECT}.git`), 'log', '-1', '--pretty=%s', 'main'])
    expect(remoteHead.trim()).toBe('agent change')

    // Every credential the helper served was asked for as a gitlab project path measured from the
    // instance root: the `gitlab/` prefix git sent under useHttpPath never reaches the project id.
    expect(gitcred.requests.length).toBeGreaterThan(0)
    for (const request of gitcred.requests) {
      expect(request).toMatchObject({ agentId: AGENT, provider: 'gitlab', repoFullName: PROJECT })
    }
  }, 120_000)

  it('runs the real glab against the instance, with a read token and the host export', async () => {
    const binDir = writeGlabShim(root, daemonEntry)
    const fakeGlab = join(mkdtempSync(join(tmpdir(), 'ac-gl-realglab-')), 'glab')
    const observed = join(root, 'glab-env.json')
    writeFileSync(
      fakeGlab,
      [
        '#!/bin/sh',
        `cat > ${JSON.stringify(observed)} <<EOF`,
        '{"token":"$GITLAB_TOKEN","host":"$GITLAB_HOST","argv":"$*"}',
        'EOF',
        ''
      ].join('\n'),
      { mode: 0o755 }
    )
    chmodSync(fakeGlab, 0o755)

    const before = gitcred.requests.length
    const glab = await run(join(binDir, 'glab'), ['mr', 'view', '1'], {
      cwd: join(root, 'checkout'),
      timeout: 120_000,
      env: {
        ...process.env,
        PATH: `${dirname(fakeGlab)}:${process.env.PATH ?? ''}`,
        AC_AGENT_ID: AGENT,
        AC_GITCRED_CAPABILITY: 'cap-test',
        // Exactly what the daemon injects at spawn: the table plus the host export.
        AC_GITCRED_HOSTS: `github=https://github.com gitlab=${instance}`,
        GITLAB_HOST: instance,
        GITLAB_TOKEN: '',
        ...SOURCE_CONDITION_ENV
      }
    })
    // The wrapper passes the token command's stderr straight through, so a refusal is visible here.
    expect(glab.stderr).toBe('')

    expect(JSON.parse(readFileSync(observed, 'utf8'))).toEqual({
      token: TOKEN,
      host: instance,
      argv: 'mr view 1'
    })
    // The token was minted for THIS project, resolved from the prefixed origin of the cwd checkout.
    expect(gitcred.requests.slice(before)).toEqual([
      { op: 'get', agentId: AGENT, capability: 'cap-test', plane: 'glab', provider: 'gitlab', repoFullName: PROJECT }
    ])
  }, 120_000)
})
