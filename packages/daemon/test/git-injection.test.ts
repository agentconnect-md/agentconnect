import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { simpleGit } from 'simple-git'
import {
  AGENT_CHANNEL_AGENT_ENV,
  AGENT_CHANNEL_CAPABILITY_ENV,
  AGENT_CHANNEL_SOCKET_ENV
} from '../src/cp/agent-channel-server.js'
import { LocalGitRunner, type GitRunner } from '../src/workspace/git-runner.js'
import {
  canonicalWorkspaceGitUrl,
  cloneGitEnv,
  daemonLocalGitEnv,
  gitEnvBase,
  gitFor,
  daemonGitCredentialTarget,
  initGitInjection,
  liveSecretsChannelEnv,
  parseGitVersion,
  syncWorkspaceRef,
  sandboxGitCredentialTarget,
  managedCredentialScope,
  sessionCredentialHosts,
  sessionGitConfig,
  sessionGitEnv,
  checkoutHelper,
  workspaceGitEnvBase,
  workspaceGitLocalEnv,
  workspaceGitRemoteTarget,
  writeRepoHelperConfig,
  mergeGitConfigEnv,
  proxiedDaemonGitEnv,
  CODE_HOST_CREDENTIAL_ENV
} from '../src/workspace/git-injection.js'
import { INSTALLATION_GIT_CREDENTIAL_WRAPPER } from '../src/shim/git-credential-wrapper.js'
import { SANDBOX_GIT_CONFIG_DIR, SANDBOX_GIT_CREDENTIAL_HELPER } from '../src/shim/sandbox-paths.js'
import { SANDBOX_TUNNEL_PATHS } from '../src/shim/tunnel.js'

// simple-git ≥3.36 refuses a NAME blocklist of env vars (presence-based, value
// never read) and requires opt-ins for credential.helper / GIT_CONFIG_COUNT.
// These tests spawn real git (`raw(['version'])`, no network) through the same
// plugin pipeline the daemon's clone/pull use — a green run here is exactly
// "the deployed daemon would not have thrown before git even started".

const POLLUTED = {
  [AGENT_CHANNEL_CAPABILITY_ENV]: 'host-capability',
  [AGENT_CHANNEL_AGENT_ENV]: 'host-agent-id', // a stale host value must never outrank the minted pair
  EDITOR: 'vim', // the observed production failure — login-shell default
  Visual: 'code', // checker matches case-insensitively; so must the strip
  PAGER: 'less',
  PREFIX: '/opt/weird',
  GIT_EDITOR: 'vim',
  GIT_SSH_COMMAND: 'ssh -i /k',
  GIT_ASKPASS: '/bin/echo',
  SSH_ASKPASS: '/bin/echo',
  GIT_ALTERNATE_OBJECT_DIRECTORIES: '/elsewhere/alternate-objects',
  GIT_COMMON_DIR: '/elsewhere/common.git',
  GIT_DIR: '/elsewhere/.git',
  GIT_GRAFT_FILE: '/elsewhere/grafts',
  GIT_IMPLICIT_WORK_TREE: '0',
  GIT_INDEX_FILE: '/elsewhere/index',
  GIT_NO_REPLACE_OBJECTS: '1',
  GIT_OBJECT_DIRECTORY: '/elsewhere/objects',
  GIT_REPLACE_REF_BASE: 'refs/elsewhere/',
  GIT_SHALLOW_FILE: '/elsewhere/shallow',
  GIT_ALLOW_PROTOCOL: 'file:ext:git:https:ssh',
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'core.editor',
  GIT_CONFIG_VALUE_0: 'vim'
} as const

function configPairs(env: Record<string, string>): Array<[string | undefined, string | undefined]> {
  return Array.from({ length: Number(env.GIT_CONFIG_COUNT ?? 0) }, (_, index) => [
    env[`GIT_CONFIG_KEY_${index}`],
    env[`GIT_CONFIG_VALUE_${index}`]
  ])
}

let tmpRun: string
const saved = new Map<string, string | undefined>()

beforeAll(() => {
  for (const [k, v] of Object.entries(POLLUTED)) {
    saved.set(k, process.env[k])
    process.env[k] = v
  }
  tmpRun = mkdtempSync(join(tmpdir(), 'gitcred-test-'))
  initGitInjection({
    // Per agent, as the daemon's own resolver is: an agent whose git runs in a pod gets the
    // image's paths, and one that runs here gets this daemon's. `pod-` ids pick the former.
    // `installed-` ids get a daemon installation as their helper root, as the host and srt strategies do.
    targetFor: (agentId) =>
      agentId.startsWith('pod-')
        ? sandboxGitCredentialTarget()
        : agentId.startsWith('installed-')
          ? sandboxGitCredentialTarget(join(tmpRun, 'hs'), join(tmpRun, 'installation'))
          : daemonGitCredentialTarget({ shimPath: join(tmpRun, 'helper.sh'), runDir: tmpRun }),
    preWarm: async () => undefined,
    // Holder-tagged, so each env shows whose capability it carries.
    capabilityFor: (agentId, holder) => `${holder}-cap-${agentId}`
  })
})

afterAll(() => {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  rmSync(tmpRun, { recursive: true, force: true })
})

describe('gitEnvBase', () => {
  it('strips every checker-blocked name (case-insensitively) and host GIT_CONFIG_*', () => {
    const env = gitEnvBase()
    for (const k of Object.keys(POLLUTED)) {
      if (k !== 'GIT_ALLOW_PROTOCOL') expect(env, k).not.toHaveProperty(k)
    }
  })

  it('limits workspace git without narrowing skill-source git', () => {
    expect(gitEnvBase().GIT_ALLOW_PROTOCOL).toBe(POLLUTED.GIT_ALLOW_PROTOCOL)
    expect(workspaceGitEnvBase().GIT_ALLOW_PROTOCOL).toBe('https:ssh')
    expect(workspaceGitLocalEnv().GIT_ALLOW_PROTOCOL).toBe('')
    expect(workspaceGitEnvBase()).toMatchObject({
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_GRAFT_FILE: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_LFS_SKIP_SMUDGE: '1',
      GIT_NO_LAZY_FETCH: '1',
      GIT_NO_REPLACE_OBJECTS: '1'
    })
    expect(workspaceGitEnvBase().GIT_CONFIG_GLOBAL).toBe(process.platform === 'win32' ? 'NUL' : '/dev/null')
    expect(Object.keys(workspaceGitEnvBase()).some((key) => /^(?:all|ftp|http|https|no)_proxy$/i.test(key))).toBe(false)
    expect(configPairs(workspaceGitEnvBase())).toContainEqual(['http.followRedirects', 'false'])
    expect(configPairs(workspaceGitEnvBase())).toContainEqual([
      'core.hooksPath',
      process.platform === 'win32' ? 'NUL' : '/dev/null'
    ])
    expect(configPairs(workspaceGitEnvBase())).toContainEqual(['core.fsmonitor', 'false'])
    expect(configPairs(workspaceGitEnvBase())).toContainEqual(['core.sparseCheckout', 'false'])
    expect(configPairs(workspaceGitEnvBase())).toContainEqual(['core.sparseCheckoutCone', 'false'])
    expect(configPairs(workspaceGitEnvBase())).toContainEqual(['checkout.workers', '2'])
    expect(configPairs(workspaceGitEnvBase())).toContainEqual(['credential.helper', ''])
    expect(configPairs(workspaceGitEnvBase())).toContainEqual(['fetch.bundleURI', ''])
    expect(configPairs(workspaceGitEnvBase())).toContainEqual(['transfer.bundleURI', 'false'])
    expect(configPairs(workspaceGitEnvBase())).toContainEqual(['fetch.uriProtocols', ''])
  })

  it('removes differently-cased inherited values before setting workspace policy', () => {
    const inherited = {
      git_allow_protocol: 'file:ext:https:ssh',
      git_lfs_skip_smudge: '0',
      git_no_lazy_fetch: '0',
      git_terminal_prompt: '1'
    }
    const previous = new Map(Object.keys(inherited).map((key) => [key, process.env[key]]))
    Object.assign(process.env, inherited)
    try {
      const env = workspaceGitEnvBase()
      for (const key of Object.keys(inherited)) expect(env).not.toHaveProperty(key)
      expect(env).toMatchObject({
        GIT_ALLOW_PROTOCOL: 'https:ssh',
        GIT_LFS_SKIP_SMUDGE: '1',
        GIT_NO_LAZY_FETCH: '1'
      })
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })

  it('keeps an explicit checkout bound when the host exports GIT_COMMON_DIR', async () => {
    const root = mkdtempSync(join(tmpdir(), 'git-context-test-'))
    const workspace = join(root, 'workspace')
    const override = join(root, 'override')
    const cleanEnv = workspaceGitLocalEnv()
    execFileSync('git', ['init', workspace], { env: cleanEnv, stdio: 'ignore' })
    execFileSync('git', ['init', override], { env: cleanEnv, stdio: 'ignore' })
    execFileSync('git', ['-C', workspace, 'remote', 'add', 'origin', 'https://other-host.example/acme/repo'], {
      env: cleanEnv
    })
    execFileSync('git', ['-C', override, 'remote', 'add', 'origin', 'https://github.com/acme/repo'], {
      env: cleanEnv
    })
    const poisonedEnv = { ...cleanEnv, GIT_COMMON_DIR: join(override, '.git') }
    expect(
      execFileSync('git', ['-C', workspace, 'remote', 'get-url', 'origin'], {
        encoding: 'utf8',
        env: poisonedEnv
      }).trim()
    ).toBe('https://github.com/acme/repo')

    try {
      await expect(
        gitFor(workspace, undefined, workspaceGitLocalEnv()).raw(['remote', 'get-url', 'origin'])
      ).resolves.toContain('https://other-host.example/acme/repo')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps daemon checkout and parent verification bound to repository objects', () => {
    const root = mkdtempSync(join(tmpdir(), 'git-object-integrity-test-'))
    const workspace = join(root, 'workspace')
    const worktree = join(root, 'worktree')
    const env = {
      ...workspaceGitLocalEnv(),
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.invalid'
    }
    try {
      execFileSync('git', ['init', '-b', 'main', workspace], { env, stdio: 'ignore' })
      writeFileSync(join(workspace, 'content'), 'trusted\n')
      writeFileSync(join(workspace, 'hidden'), 'complete\n')
      execFileSync('git', ['-C', workspace, 'add', 'content', 'hidden'], { env })
      execFileSync('git', ['-C', workspace, 'commit', '-m', 'trusted'], { env, stdio: 'ignore' })
      const trusted = execFileSync('git', ['-C', workspace, 'rev-parse', 'HEAD'], {
        env,
        encoding: 'utf8'
      }).trim()

      writeFileSync(join(workspace, 'content'), 'replacement\n')
      execFileSync('git', ['-C', workspace, 'add', 'content'], { env })
      execFileSync('git', ['-C', workspace, 'commit', '-m', 'replacement'], { env, stdio: 'ignore' })
      const replacement = execFileSync('git', ['-C', workspace, 'rev-parse', 'HEAD'], {
        env,
        encoding: 'utf8'
      }).trim()

      execFileSync('git', ['-C', workspace, 'replace', trusted, replacement], { env })
      writeFileSync(join(workspace, '.git', 'info', 'grafts'), `${replacement} ${replacement}\n`)
      execFileSync('git', ['-C', workspace, 'config', 'core.sparseCheckout', 'true'], { env })
      writeFileSync(join(workspace, '.git', 'info', 'sparse-checkout'), 'content\n')

      expect(
        execFileSync('git', ['-C', workspace, 'rev-list', '--parents', '-n', '1', replacement], {
          env,
          encoding: 'utf8'
        }).trim()
      ).toBe(`${replacement} ${trusted}`)
      execFileSync('git', ['-C', workspace, 'worktree', 'add', '--detach', worktree, trusted], {
        env,
        stdio: 'ignore'
      })
      expect(readFileSync(join(worktree, 'content'), 'utf8')).toBe('trusted\n')
      expect(readFileSync(join(worktree, 'hidden'), 'utf8')).toBe('complete\n')
      expect(execFileSync('git', ['-C', worktree, 'rev-parse', 'HEAD'], { env, encoding: 'utf8' }).trim()).toBe(trusted)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps redirects disabled when repo-local URL config tries to re-enable them', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'git-redirect-policy-test-'))
    const repository = 'https://github.com/acme/repo.git'
    try {
      const localEnv = workspaceGitLocalEnv()
      execFileSync('git', ['init', workspace], { env: localEnv, stdio: 'ignore' })
      execFileSync('git', ['-C', workspace, 'config', `http.${repository}.followRedirects`, 'true'], {
        env: localEnv
      })
      expect(
        execFileSync('git', ['-C', workspace, 'config', '--get-urlmatch', 'http.followRedirects', repository], {
          encoding: 'utf8',
          env: workspaceGitEnvBase(repository)
        }).trim()
      ).toBe('false')
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('pins a full target against broader URL rewrites', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'git-url-policy-test-'))
    const repository = 'https://github.com/acme/repo.git'
    const localEnv = workspaceGitLocalEnv()
    try {
      execFileSync('git', ['init', workspace], { env: localEnv, stdio: 'ignore' })
      execFileSync(
        'git',
        ['-C', workspace, 'config', 'url.https://127.0.0.1.invalid/redirected/.insteadOf', 'https://github.com/'],
        { env: localEnv }
      )
      expect(
        execFileSync('git', ['-C', workspace, 'ls-remote', '--get-url', repository], {
          encoding: 'utf8',
          env: workspaceGitEnvBase(repository)
        }).trim()
      ).toBe(repository)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('uses a daemon-owned remote name instead of a URL-shaped checkout remote', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'git-remote-policy-test-'))
    const repository = 'https://github.com/acme/repo.git'
    const redirected = 'https://127.0.0.1/private.git'
    try {
      execFileSync('git', ['init', workspace], { env: workspaceGitLocalEnv(), stdio: 'ignore' })
      execFileSync('git', ['-C', workspace, 'config', `remote.${repository}.url`, redirected], {
        env: workspaceGitLocalEnv()
      })

      const target = workspaceGitRemoteTarget(repository)
      expect(target.remote).toMatch(/^agentconnect-[0-9a-f-]+$/)
      expect(configPairs(target.env).filter(([key]) => key === `remote.${target.remote}.url`)).toEqual([
        [`remote.${target.remote}.url`, repository]
      ])
      expect(configPairs(target.env)).toContainEqual([`remote.${target.remote}.proxy`, ''])
      expect(
        execFileSync('git', ['-C', workspace, 'config', '--get-all', `remote.${target.remote}.url`], {
          encoding: 'utf8',
          env: target.env
        }).trim()
      ).toBe(repository)
      expect(
        execFileSync('git', ['-C', workspace, 'ls-remote', '--get-url', target.remote], {
          encoding: 'utf8',
          env: target.env
        }).trim()
      ).toBe(repository)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it.each(['default', 'custom'] as const)('does not execute %s post-merge hooks in daemon-owned Git', (mode) => {
    const root = mkdtempSync(join(tmpdir(), `git-hook-policy-${mode}-`))
    const workspace = join(root, 'workspace')
    const marker = join(root, 'executed')
    const setupEnv = workspaceGitLocalEnv()
    try {
      execFileSync('git', ['init', '-b', 'main', workspace], { env: setupEnv, stdio: 'ignore' })
      execFileSync('git', ['-C', workspace, 'config', 'user.name', 'Test'], { env: setupEnv })
      execFileSync('git', ['-C', workspace, 'config', 'user.email', 'test@example.invalid'], { env: setupEnv })
      writeFileSync(join(workspace, 'initial'), 'initial\n')
      execFileSync('git', ['-C', workspace, 'add', 'initial'], { env: setupEnv })
      execFileSync('git', ['-C', workspace, 'commit', '-m', 'initial'], { env: setupEnv, stdio: 'ignore' })
      execFileSync('git', ['-C', workspace, 'checkout', '-b', 'advance'], { env: setupEnv, stdio: 'ignore' })
      writeFileSync(join(workspace, 'advance'), 'advance\n')
      execFileSync('git', ['-C', workspace, 'add', 'advance'], { env: setupEnv })
      execFileSync('git', ['-C', workspace, 'commit', '-m', 'advance'], { env: setupEnv, stdio: 'ignore' })
      const advance = execFileSync('git', ['-C', workspace, 'rev-parse', 'HEAD'], {
        env: setupEnv,
        encoding: 'utf8'
      }).trim()
      execFileSync('git', ['-C', workspace, 'checkout', 'main'], { env: setupEnv, stdio: 'ignore' })

      const hookRoot = mode === 'default' ? join(workspace, '.git', 'hooks') : join(workspace, 'custom-hooks')
      mkdirSync(hookRoot, { recursive: true })
      if (mode === 'custom') {
        execFileSync('git', ['-C', workspace, 'config', 'core.hooksPath', hookRoot], { env: setupEnv })
      }
      const hook = join(hookRoot, 'post-merge')
      writeFileSync(hook, `#!/bin/sh\nprintf executed > '${marker}'\n`)
      chmodSync(hook, 0o755)

      execFileSync('git', ['-C', workspace, 'merge', '--ff-only', advance], {
        env: workspaceGitEnvBase(),
        stdio: 'ignore'
      })
      expect(existsSync(marker)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not execute a checkout-owned credential helper in daemon network Git', () => {
    const root = mkdtempSync(join(tmpdir(), 'git-credential-policy-'))
    const workspace = join(root, 'workspace')
    const marker = join(root, 'executed')
    const localEnv = workspaceGitLocalEnv()
    try {
      execFileSync('git', ['init', workspace], { env: localEnv, stdio: 'ignore' })
      execFileSync(
        'git',
        [
          '-C',
          workspace,
          'config',
          'credential.https://example.invalid.helper',
          `!printf executed > '${marker}'; exit 1`
        ],
        { env: localEnv }
      )
      try {
        execFileSync('git', ['-C', workspace, 'credential', 'fill'], {
          env: { ...workspaceGitEnvBase('https://example.invalid/acme/repo.git'), GIT_TERMINAL_PROMPT: '0' },
          input: 'protocol=https\nhost=example.invalid\npath=acme/repo.git\n\n',
          stdio: ['pipe', 'ignore', 'ignore']
        })
      } catch {
        // No trusted helper was installed in this fixture; failure is expected.
      }
      expect(existsSync(marker)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('updates the origin tracking ref when a sync advances HEAD', async () => {
    const root = mkdtempSync(join(tmpdir(), 'git-pull-refspec-test-'))
    const remote = join(root, 'remote.git')
    const seed = join(root, 'seed')
    const workspace = join(root, 'workspace')
    const env = { ...workspaceGitLocalEnv(), GIT_ALLOW_PROTOCOL: 'file:https:ssh' }
    const run = (args: string[]) => execFileSync('git', args, { env, stdio: 'ignore' })

    try {
      run(['init', '--bare', remote])
      run(['init', '-b', 'main', seed])
      run(['-C', seed, 'config', 'user.name', 'Test'])
      run(['-C', seed, 'config', 'user.email', 'test@example.invalid'])
      run(['-C', seed, 'commit', '--allow-empty', '-m', 'initial'])
      run(['-C', seed, 'remote', 'add', 'origin', remote])
      run(['-C', seed, 'push', 'origin', 'main'])
      run(['clone', '--branch', 'main', remote, workspace])
      run(['-C', seed, 'commit', '--allow-empty', '-m', 'advance'])
      run(['-C', seed, 'push', 'origin', 'main'])

      const git = gitFor(workspace, undefined, env)
      const runner = new LocalGitRunner(git, workspace, (overrides) => gitFor(workspace, undefined, overrides), env)
      const moved = await syncWorkspaceRef(runner, 'origin', 'main')
      expect(moved.switchedFrom).toBeUndefined()

      const [head, tracking, status] = await Promise.all([
        git.raw(['rev-parse', 'HEAD']),
        git.raw(['rev-parse', 'refs/remotes/origin/main']),
        git.status()
      ])
      expect(head.trim()).toBe(tracking.trim())
      expect(status.ahead).toBe(0)
      expect(status.behind).toBe(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  // One remote, one clone of it, both on `main`; the caller then moves the clone into the shape under test.
  function seedSyncFixture(prefix: string) {
    const root = mkdtempSync(join(tmpdir(), prefix))
    const remote = join(root, 'remote.git')
    const seed = join(root, 'seed')
    const workspace = join(root, 'workspace')
    const env = { ...workspaceGitLocalEnv(), GIT_ALLOW_PROTOCOL: 'file:https:ssh' }
    const run = (args: string[]) => execFileSync('git', args, { env, stdio: 'ignore' })
    run(['init', '--bare', remote])
    run(['init', '-b', 'main', seed])
    run(['-C', seed, 'config', 'user.name', 'Test'])
    run(['-C', seed, 'config', 'user.email', 'test@example.invalid'])
    writeFileSync(join(seed, 'README.md'), 'one\n')
    run(['-C', seed, 'add', 'README.md'])
    run(['-C', seed, 'commit', '-m', 'initial'])
    run(['-C', seed, 'remote', 'add', 'origin', remote])
    run(['-C', seed, 'push', 'origin', 'main'])
    run(['clone', '--branch', 'main', remote, workspace])
    run(['-C', workspace, 'config', 'user.name', 'Test'])
    run(['-C', workspace, 'config', 'user.email', 'test@example.invalid'])
    const git = gitFor(workspace, undefined, env)
    const runner = new LocalGitRunner(git, workspace, (overrides) => gitFor(workspace, undefined, overrides), env)
    return { root, seed, workspace, env, run, git, runner }
  }

  it('switches a checkout left on another branch back to the configured one, carrying uncommitted edits', async () => {
    const { root, seed, workspace, run, git, runner } = seedSyncFixture('git-sync-switch-test-')
    try {
      // The agent branched off, committed there, and left an unrelated edit uncommitted; the remote moved on.
      run(['-C', workspace, 'checkout', '-b', 'dev/agent/canary'])
      writeFileSync(join(workspace, 'canary.txt'), 'canary\n')
      run(['-C', workspace, 'add', 'canary.txt'])
      run(['-C', workspace, 'commit', '-m', 'canary'])
      writeFileSync(join(workspace, 'notes.md'), 'work in progress\n')
      writeFileSync(join(seed, 'README.md'), 'one\ntwo\n')
      run(['-C', seed, 'commit', '-am', 'advance'])
      run(['-C', seed, 'push', 'origin', 'main'])

      const moved = await syncWorkspaceRef(runner, 'origin', 'main')

      expect(moved.switchedFrom).toBe('dev/agent/canary')
      // Everything between the two HEADs: the remote's edit and the canary file that only the agent's branch has.
      expect(moved.files.sort()).toEqual(['README.md', 'canary.txt'])
      expect((await git.raw(['symbolic-ref', '--short', 'HEAD'])).trim()).toBe('main')
      expect((await git.raw(['rev-parse', 'HEAD'])).trim()).toBe(
        (await git.raw(['rev-parse', 'refs/remotes/origin/main'])).trim()
      )
      // The edit rode along; the agent's own branch and its commit are untouched.
      expect(readFileSync(join(workspace, 'notes.md'), 'utf8')).toBe('work in progress\n')
      expect((await git.raw(['rev-list', '--count', 'dev/agent/canary', '^main'])).trim()).toBe('1')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('refuses rather than discarding a local commit the remote lacks', async () => {
    const { root, seed, workspace, run, git, runner } = seedSyncFixture('git-sync-refuse-test-')
    try {
      writeFileSync(join(workspace, 'local.txt'), 'local\n')
      run(['-C', workspace, 'add', 'local.txt'])
      run(['-C', workspace, 'commit', '-m', 'unpushed'])
      const before = (await git.raw(['rev-parse', 'HEAD'])).trim()
      run(['-C', seed, 'commit', '--allow-empty', '-m', 'advance'])
      run(['-C', seed, 'push', 'origin', 'main'])

      await expect(syncWorkspaceRef(runner, 'origin', 'main')).rejects.toThrow(
        /local main has 1 commit the remote does not/
      )
      expect((await git.raw(['rev-parse', 'HEAD'])).trim()).toBe(before)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('refuses when an uncommitted edit touches a file the sync would rewrite', async () => {
    const { root, seed, workspace, run, git, runner } = seedSyncFixture('git-sync-overlap-test-')
    try {
      writeFileSync(join(workspace, 'README.md'), 'one\nlocal edit\n')
      writeFileSync(join(seed, 'README.md'), 'one\ntwo\n')
      run(['-C', seed, 'commit', '-am', 'advance'])
      run(['-C', seed, 'push', 'origin', 'main'])
      const before = (await git.raw(['rev-parse', 'HEAD'])).trim()

      await expect(syncWorkspaceRef(runner, 'origin', 'main')).rejects.toThrow(/README\.md/)
      expect((await git.raw(['rev-parse', 'HEAD'])).trim()).toBe(before)
      expect(readFileSync(join(workspace, 'README.md'), 'utf8')).toBe('one\nlocal edit\n')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps ambient host capabilities', () => {
    const env = gitEnvBase()
    expect(env.PATH).toBe(process.env.PATH)
    expect(env.HOME).toBe(process.env.HOME)
  })
})

describe('cloneGitEnv', () => {
  it('invokes the helper positionally — no --agent flag for tsx to swallow', () => {
    const env = cloneGitEnv('agent-1')
    const helper = Object.entries(env).find(([, v]) => v.startsWith('!'))?.[1]
    expect(helper).toBeDefined()
    expect(helper).not.toContain('--agent')
    expect(helper).toMatch(/ agent-1$/)
  })

  it('injects the runtime capability without writing it to the session gitconfig', () => {
    expect(cloneGitEnv('agent-1')[AGENT_CHANNEL_CAPABILITY_ENV]).toBe('daemon-cap-agent-1')
    const session = sessionGitEnv('agent-1')
    expect(session[AGENT_CHANNEL_CAPABILITY_ENV]).toBe('runtime-cap-agent-1')
    expect(readFileSync(session.GIT_CONFIG_GLOBAL!, 'utf8')).not.toContain('cap-agent-1')
  })

  it('gives git the daemon runs the daemon capability and the agent runtime its own, in every filesystem', () => {
    for (const agentId of ['agent-1', 'pod-1', 'installed-1']) {
      expect(cloneGitEnv(agentId)[AGENT_CHANNEL_CAPABILITY_ENV]).toBe(`daemon-cap-${agentId}`)
      expect(daemonLocalGitEnv(agentId)[AGENT_CHANNEL_CAPABILITY_ENV]).toBe(`daemon-cap-${agentId}`)
      expect(
        workspaceGitRemoteTarget('https://github.com/acme/repo.git', agentId).env[AGENT_CHANNEL_CAPABILITY_ENV]
      ).toBe(`daemon-cap-${agentId}`)
      expect(sessionGitConfig(agentId).env[AGENT_CHANNEL_CAPABILITY_ENV]).toBe(`runtime-cap-${agentId}`)
      expect(liveSecretsChannelEnv(agentId)[AGENT_CHANNEL_CAPABILITY_ENV]).toBe(`runtime-cap-${agentId}`)
    }
  })

  it('mints the env identity as a pair with the capability (helper outranks config-embedded ids)', () => {
    expect(cloneGitEnv('agent-1')[AGENT_CHANNEL_AGENT_ENV]).toBe('agent-1')
    expect(sessionGitEnv('agent-1')[AGENT_CHANNEL_AGENT_ENV]).toBe('agent-1')
  })

  it('keeps the redirect guard alongside GitHub App credential config', () => {
    const pairs = configPairs(cloneGitEnv('agent-1', 'https://github.com/acme/repo.git'))
    expect(pairs).toContainEqual(['http.followRedirects', 'false'])
    expect(pairs).toContainEqual(['url.https://github.com/acme/repo.git.insteadOf', 'https://github.com/acme/repo.git'])
    expect(pairs).toContainEqual(['http.https://github.com/acme/repo.git.followRedirects', 'false'])
    expect(pairs).toContainEqual(['http.https://github.com/acme/repo.git.proxy', ''])
    expect(pairs).toContainEqual(['http.https://github.com/acme/repo.git.curloptResolve', ''])
    expect(pairs).toContainEqual(['credential.https://github.com.useHttpPath', 'true'])
  })

  it('pins SSH routing to the explicit URL instead of user SSH config', () => {
    const pairs = configPairs(workspaceGitEnvBase('ssh://git@github.com/acme/repo.git'))
    expect(pairs).toContainEqual([
      'url.ssh://git@github.com/acme/repo.git.insteadOf',
      'ssh://git@github.com/acme/repo.git'
    ])
    expect(pairs).toContainEqual([
      'core.sshCommand',
      'ssh -F none -o ProxyCommand=none -o ProxyJump=none -o PermitLocalCommand=no -o ClearAllForwardings=yes'
    ])
  })
})

describe('canonicalWorkspaceGitUrl', () => {
  // GitLab 301s the suffix-less ref probe to the `.git` form and daemon Git pins http.followRedirects=false.
  it('gives a gitlab HTTPS remote its `.git` form, at any subgroup depth and on any host', () => {
    expect(canonicalWorkspaceGitUrl('https://gitlab.com/example-group/example-project', 'gitlab')).toBe(
      'https://gitlab.com/example-group/example-project.git'
    )
    expect(canonicalWorkspaceGitUrl('https://gitlab.com/example-group/sub/deeper/example-project', 'gitlab')).toBe(
      'https://gitlab.com/example-group/sub/deeper/example-project.git'
    )
    // A trailing slash is the same repository, so it must not produce `…/.git`.
    expect(canonicalWorkspaceGitUrl('https://gitlab.com/example-group/example-project/', 'gitlab')).toBe(
      'https://gitlab.com/example-group/example-project.git'
    )
    // §24.4: the suffix rule keys on the PROVIDER, so a self-managed instance gets it too.
    expect(
      canonicalWorkspaceGitUrl('https://gitlab.example.test:8443/gitlab/example-group/example-project', 'gitlab')
    ).toBe('https://gitlab.example.test:8443/gitlab/example-group/example-project.git')
  })

  it('is idempotent: a remote that already carries the suffix is left exactly as configured', () => {
    expect(canonicalWorkspaceGitUrl('https://gitlab.com/example-group/example-project.git', 'gitlab')).toBe(
      'https://gitlab.com/example-group/example-project.git'
    )
    // Git matches the suffix case-insensitively; appending a second one would name a different path.
    expect(canonicalWorkspaceGitUrl('https://gitlab.com/example-group/example-project.GIT', 'gitlab')).toBe(
      'https://gitlab.com/example-group/example-project.GIT'
    )
  })

  it('leaves every non-gitlab provider byte-identical, whatever host the URL names', () => {
    expect(canonicalWorkspaceGitUrl('https://github.com/acme/infra', 'github')).toBe('https://github.com/acme/infra')
    expect(canonicalWorkspaceGitUrl('https://github.com/acme/infra.git', 'github')).toBe(
      'https://github.com/acme/infra.git'
    )
    expect(canonicalWorkspaceGitUrl('https://code.example.test/acme/infra')).toBe(
      'https://code.example.test/acme/infra'
    )
    // An anonymous workspace on a gitlab-looking host is not a gitlab CONSUMER, so no suffix.
    expect(canonicalWorkspaceGitUrl('https://gitlab.com/example-group/example-project')).toBe(
      'https://gitlab.com/example-group/example-project'
    )
  })

  it('leaves gitlab SSH alone — only the HTTPS ref probe redirects', () => {
    expect(canonicalWorkspaceGitUrl('ssh://git@gitlab.com/example-group/example-project', 'gitlab')).toBe(
      'ssh://git@gitlab.com/example-group/example-project'
    )
    expect(canonicalWorkspaceGitUrl('git@gitlab.com:example-group/example-project', 'gitlab')).toBe(
      'git@gitlab.com:example-group/example-project'
    )
  })

  it('still refuses what the shared codec refuses, so canonicalization cannot admit a new target', () => {
    expect(() => canonicalWorkspaceGitUrl('/srv/local/repo')).toThrow('local git paths are not supported')
    expect(() => canonicalWorkspaceGitUrl('ext::payload')).toThrow('git clone url must use https or ssh')
  })
})

describe('workspaceGitRemoteTarget', () => {
  it('binds the authorized URL to an unguessable remote name', () => {
    const target = workspaceGitRemoteTarget('https://github.com/acme/repo.git', 'agent-1')
    expect(target.remote).toMatch(/^agentconnect-[0-9a-f-]{36}$/)
    const pairs = configPairs(target.env)
    expect(pairs).toContainEqual([`remote.${target.remote}.url`, 'https://github.com/acme/repo.git'])
    expect(pairs).toContainEqual([`remote.${target.remote}.proxy`, ''])
    expect(target.env.GIT_ALLOW_PROTOCOL).toBe('https:ssh')
    expect(target.env.GIT_TERMINAL_PROMPT).toBe('0')
  })

  it('re-adds the credential helper AFTER the command-scope reset that would wipe it', () => {
    // The reset is `credential.helper=''` at command scope, which clears the WHOLE accumulated
    // helper list — including the URL-scoped repo-local pin written post-clone. Verified on git
    // 2.43: a helper listed before it never runs. So this target's own pointer has to come after it.
    const target = workspaceGitRemoteTarget('https://github.com/acme/repo.git', 'agent-1')
    const pairs = configPairs(target.env)
    const reset = pairs.findIndex(([key, value]) => key === 'credential.helper' && value === '')
    const helper = pairs.findIndex(
      ([key, value]) => key === 'credential.https://github.com.helper' && (value ?? '').startsWith('!')
    )
    expect(reset).toBeGreaterThanOrEqual(0)
    expect(helper).toBeGreaterThan(reset)
    expect(pairs).toContainEqual(['credential.https://github.com.useHttpPath', 'true'])
    expect(target.env[AGENT_CHANNEL_CAPABILITY_ENV]).toBe('daemon-cap-agent-1')
    expect(target.env[AGENT_CHANNEL_AGENT_ENV]).toBe('agent-1')
  })

  it('declares the remote a promisor with the session clone filter only when asked to', () => {
    const blobless = workspaceGitRemoteTarget('https://github.com/acme/repo.git', 'agent-1', undefined, {
      blobless: true
    })
    expect(configPairs(blobless.env)).toEqual(
      expect.arrayContaining([
        [`remote.${blobless.remote}.promisor`, 'true'],
        [`remote.${blobless.remote}.partialclonefilter`, 'blob:none']
      ])
    )
    const full = workspaceGitRemoteTarget('https://github.com/acme/repo.git', 'agent-1')
    expect(configPairs(full.env).some(([key]) => key?.endsWith('.promisor'))).toBe(false)
  })

  it('omits the helper entirely for a workspace the daemon issues no credentials for', () => {
    const target = workspaceGitRemoteTarget('ssh://git@github.com/acme/repo.git')
    const pairs = configPairs(target.env)
    expect(pairs.some(([key]) => key === 'credential.https://github.com.helper')).toBe(false)
    expect(target.env[AGENT_CHANNEL_CAPABILITY_ENV]).toBeUndefined()
    // Still the full hardening set — an ssh target keeps its pinned command and no user routing.
    expect(pairs).toContainEqual(['core.hooksPath', process.platform === 'win32' ? 'NUL' : '/dev/null'])
    expect(pairs).toContainEqual(['ssh.variant', 'ssh'])
  })

  it('passes the simple-git unsafe checker for the argv it produces', async () => {
    // Same guarantee the clone env gets: the credential-helper pairs and the GIT_CONFIG_COUNT
    // channel each need an opt-in, and only handles built by `gitFor` carry it.
    const target = workspaceGitRemoteTarget('https://github.com/acme/repo.git', 'agent-1')
    await expect(gitFor(undefined, undefined, target.env).raw(['version'])).resolves.toContain('git version')
  })
})

describe('sessionGitEnv', () => {
  // The policy lives in the FILE, not in indexed env pairs. Read per process inside a runtime pod:
  // the ACP runtime had GIT_CONFIG_COUNT plus both KEY/VALUE pairs, while its own child had COUNT
  // alone — enough for git to refuse EVERY invocation with "unable to parse command-line config".
  const HOOKS_PATH = process.platform === 'win32' ? 'NUL' : '/dev/null'

  it('carries the hooks and fsmonitor policy in the file, for a pod launch and a daemon launch alike', () => {
    const daemonLaunch = readFileSync(sessionGitEnv('agent-1').GIT_CONFIG_GLOBAL!, 'utf8')
    expect(daemonLaunch).toContain(`hooksPath = ${HOOKS_PATH}`)
    expect(daemonLaunch).toContain('fsmonitor = false')
    // A --k8s launch never writes here, so its content is asserted where the pod would read it.
    const podLaunch = sessionGitConfig('agent-1', undefined, sandboxGitCredentialTarget()).content
    expect(podLaunch).toContain(`hooksPath = ${HOOKS_PATH}`)
    expect(podLaunch).toContain('fsmonitor = false')
  })

  it('leaves no indexed command-scope config in any session launch env', () => {
    const launches = [
      sessionGitEnv('agent-1'),
      sessionGitEnv('agent-2', undefined, null),
      sessionGitConfig('agent-1', undefined, sandboxGitCredentialTarget()).env,
      sessionGitConfig('agent-2', undefined, sandboxGitCredentialTarget(), null).env
    ]
    for (const env of launches) {
      expect(env).not.toHaveProperty('GIT_CONFIG_COUNT')
      expect(Object.keys(env).filter((key) => key.startsWith('GIT_CONFIG_KEY_'))).toEqual([])
      expect(env.GIT_CONFIG_GLOBAL).toBeDefined()
    }
  })

  it('gives a credential-free git workspace the policy and no credential pointer at all', () => {
    const env = sessionGitEnv('agent-2', undefined, null)
    const content = readFileSync(env.GIT_CONFIG_GLOBAL!, 'utf8')
    expect(content).toContain(`hooksPath = ${HOOKS_PATH}`)
    expect(content).not.toContain('[credential')
    expect(env[AGENT_CHANNEL_CAPABILITY_ENV]).toBeUndefined()
    expect(env[AGENT_CHANNEL_AGENT_ENV]).toBeUndefined()
  })

  // A credential-stripped host (a dream) coexists with the warm credentialed one and shares its pod
  // on the pool, so the two must never name the same file: policy-only content landing on the
  // credentialed path would cut the live runtime's helper and reset until that host is rebuilt.
  it('keys the file by what it contains, so a credential-stripped host cannot overwrite the other', () => {
    const podCredentialed = sessionGitConfig('agent-1', undefined, sandboxGitCredentialTarget())
    const podPolicyOnly = sessionGitConfig('agent-1', undefined, sandboxGitCredentialTarget(), null)
    expect(podPolicyOnly.path).not.toBe(podCredentialed.path)
    // Both are materialized into the one pod, so they have to coexist in the same directory.
    expect(dirname(podPolicyOnly.path)).toBe(dirname(podCredentialed.path))
    expect(podCredentialed.content).toContain('[credential')
    expect(podPolicyOnly.content).not.toContain('[credential')

    // On this daemon's disk the same holds, and it holds AFTER the policy-only write, not just in
    // the returned paths — the warm host is still pointing at the credentialed file.
    const credentialed = sessionGitEnv('agent-1')
    const policyOnly = sessionGitEnv('agent-1', undefined, null)
    expect(policyOnly.GIT_CONFIG_GLOBAL).not.toBe(credentialed.GIT_CONFIG_GLOBAL)
    expect(readFileSync(credentialed.GIT_CONFIG_GLOBAL!, 'utf8')).toContain('[credential')
    expect(readFileSync(policyOnly.GIT_CONFIG_GLOBAL!, 'utf8')).not.toContain('[credential')
  })

  // Real git resolves these, because the whole defect was a channel that looked right and was not.
  it.skipIf(process.platform === 'win32')('outranks a host gitconfig hooksPath by sitting AFTER the include', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gitcred-host-'))
    try {
      const hostConfig = join(dir, 'host.gitconfig')
      writeFileSync(hostConfig, '[core]\n\thooksPath = /host/hooks\n')
      const cfg = sessionGitConfig('agent-1', undefined, {
        kind: 'daemon',
        helper: join(tmpRun, 'helper.sh'),
        configDir: dir,
        hostConfig
      })
      writeFileSync(cfg.path, cfg.content)
      expect(cfg.content.indexOf('[include]')).toBeLessThan(cfg.content.indexOf('hooksPath = /dev/null'))
      const env = { ...gitEnvBase(), ...cfg.env }
      expect(
        execFileSync('git', ['config', '--get', 'core.hooksPath'], { cwd: dir, encoding: 'utf8', env }).trim()
      ).toBe('/dev/null')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // The KNOWN cost of moving off the indexed channel: GIT_CONFIG_GLOBAL is global scope, which
  // repository-local config outranks, where command scope outranked everything. Daemon-run git is
  // unaffected (workspaceGitConfigPairs still pins both at command scope) and a confined runtime
  // cannot write .git/config, but an unconfined agent's own git can now opt back into its hooks.
  it.skipIf(process.platform === 'win32')(
    'lets a repository-local hooksPath win, which the indexed channel refused',
    () => {
      const repo = mkdtempSync(join(tmpdir(), 'gitcred-repo-'))
      try {
        const env = { ...gitEnvBase(), ...sessionGitEnv('agent-1') }
        execFileSync('git', ['init', '-q'], { cwd: repo, env })
        const read = () =>
          execFileSync('git', ['config', '--get', 'core.hooksPath'], { cwd: repo, encoding: 'utf8', env }).trim()
        expect(read()).toBe('/dev/null')
        execFileSync('git', ['config', '--local', 'core.hooksPath', join(repo, 'hooks')], { cwd: repo, env })
        expect(read()).toBe(join(repo, 'hooks'))
      } finally {
        rmSync(repo, { recursive: true, force: true })
      }
    }
  )

  // The runner shells out to `git var GIT_AUTHOR_IDENT`, which the runner image cannot answer here.
  it.skipIf(process.platform === 'win32')('pins the CP-provided bot as both author and committer', () => {
    const env = sessionGitEnv('agent-1', {
      name: 'agentconnect-example[bot]',
      email: '123456+agentconnect-example[bot]@users.noreply.github.com'
    })
    expect(env).toMatchObject({
      GIT_AUTHOR_NAME: 'agentconnect-example[bot]',
      GIT_AUTHOR_EMAIL: '123456+agentconnect-example[bot]@users.noreply.github.com',
      GIT_COMMITTER_NAME: 'agentconnect-example[bot]',
      GIT_COMMITTER_EMAIL: '123456+agentconnect-example[bot]@users.noreply.github.com'
    })

    const childEnv = { ...gitEnvBase(), ...env }
    expect(execFileSync('git', ['var', 'GIT_AUTHOR_IDENT'], { encoding: 'utf8', env: childEnv })).toMatch(
      /^agentconnect-example\[bot\] <123456\+agentconnect-example\[bot\]@users\.noreply\.github\.com>/
    )
    expect(execFileSync('git', ['var', 'GIT_COMMITTER_IDENT'], { encoding: 'utf8', env: childEnv })).toMatch(
      /^agentconnect-example\[bot\] <123456\+agentconnect-example\[bot\]@users\.noreply\.github\.com>/
    )
  })

  it('omits identity overrides when connected to an older CP', () => {
    const env = sessionGitEnv('agent-1')
    expect(env).not.toHaveProperty('GIT_AUTHOR_NAME')
    expect(env).not.toHaveProperty('GIT_COMMITTER_NAME')
  })
})

// Pod coordinates are POSIX by construction — the sandbox pod is always Linux.
describe.skipIf(process.platform === 'win32')('pointers for an agent whose git runs in a sandbox pod', () => {
  // The bug every case here is about: a path is only meaningful in one filesystem, and a helper
  // line built from this daemon's root names an executable the pod has never had. What makes it
  // expensive is the failure mode — git reports an authentication failure, not a missing file.
  it('names the image helper and the tunnelled socket, never a daemon path', () => {
    const pairs = configPairs(cloneGitEnv('pod-agent', 'https://github.com/acme/repo.git'))
    expect(pairs).toContainEqual([
      'credential.https://github.com.helper',
      `!sh '${SANDBOX_GIT_CREDENTIAL_HELPER}' pod-agent`
    ])
    // The helper has no daemon root to derive a socket from, so the tunnel's path travels with it.
    expect(cloneGitEnv('pod-agent')[AGENT_CHANNEL_SOCKET_ENV]).toBe(SANDBOX_TUNNEL_PATHS.agent)
    expect(JSON.stringify(pairs)).not.toContain(tmpRun)
  })

  it('keeps the daemon-local pointers exactly as they were', () => {
    // The regression guard for every self-hosted daemon: this path is the one in production today.
    const pairs = configPairs(cloneGitEnv('agent-1', 'https://github.com/acme/repo.git'))
    expect(pairs).toContainEqual(['credential.https://github.com.helper', `!'${join(tmpRun, 'helper.sh')}' agent-1`])
    expect(cloneGitEnv('agent-1')).not.toHaveProperty(AGENT_CHANNEL_SOCKET_ENV)
  })

  it('puts the session gitconfig in the pod and drops the daemon operator home include', () => {
    const local = sessionGitConfig('agent-1')
    expect(local.path).toBe(join(tmpRun, 'gitcred', 'agent-1.gitconfig'))
    // The host's own config still rides along for a daemon-run git — that is where a self-hosting
    // operator's non-identity settings live.
    expect(local.content).toContain(join(homedir(), '.gitconfig'))

    const pod = sessionGitConfig('pod-agent')
    expect(pod.path).toBe(`${SANDBOX_GIT_CONFIG_DIR}/pod-agent.gitconfig`)
    expect(pod.env.GIT_CONFIG_GLOBAL).toBe(pod.path)
    // Including a path from the daemon's home would resolve to nothing in the pod and read as if
    // the operator simply had no config — a silent difference rather than an error.
    expect(pod.content).not.toContain('[include]')
    expect(pod.content).not.toContain(homedir())
  })

  it('computes pod coordinates for an EXPLICIT sandbox target, whatever targetFor answers', () => {
    // The spawn path knows a --k8s launch lands in the pod before the shim channel is attached,
    // so its env must not depend on binding order: 'agent-1' resolves to the daemon target here.
    const pod = sessionGitConfig('agent-1', undefined, sandboxGitCredentialTarget())
    expect(pod.path).toBe(`${SANDBOX_GIT_CONFIG_DIR}/agent-1.gitconfig`)
    expect(pod.env.GIT_CONFIG_GLOBAL).toBe(pod.path)
    expect(pod.env[AGENT_CHANNEL_SOCKET_ENV]).toBe(SANDBOX_TUNNEL_PATHS.agent)
    // The runtime's git presents the placeholder, never the helper.
    expect(pod.content).toContain(CODE_HOST_CREDENTIAL_ENV)
    expect(pod.content).not.toContain(SANDBOX_GIT_CREDENTIAL_HELPER)
    expect(pod.content).not.toContain(homedir())
  })

  it('refuses to WRITE a pod gitconfig, rather than writing it here', () => {
    // The whole class of bug in one assertion: a synchronous write of `/run/agentconnect/...`
    // lands on the daemon's disk, creating the file a check would look for while the pod has none.
    expect(() => sessionGitEnv('pod-agent')).toThrow(/materialize its gitconfig/)
    expect(existsSync(join(SANDBOX_GIT_CONFIG_DIR, 'pod-agent.gitconfig'))).toBe(false)
  })

  it('runs an installation helper that npm shipped without its executable bit', () => {
    // npm packs every non-`bin` file as 0644 and only the CLI restores modes, so a daemon installation's
    // `bin/git-credential` arrives non-executable on any host whose CLI predates the fix.
    const installation = join(tmpRun, 'installation')
    mkdirSync(join(installation, 'bin'), { recursive: true })
    mkdirSync(join(installation, 'shim'), { recursive: true })
    writeFileSync(join(installation, 'bin', 'git-credential'), INSTALLATION_GIT_CREDENTIAL_WRAPPER)
    chmodSync(join(installation, 'bin', 'git-credential'), 0o644)
    // A stand-in for the built helper bundle that echoes its argv back as the password.
    writeFileSync(
      join(installation, 'shim', 'git-credential.js'),
      "process.stdout.write(`username=x-access-token\\npassword=${process.argv.slice(2).join('+')}\\n`)\n"
    )
    const out = execFileSync('git', ['credential', 'fill'], {
      input: 'protocol=https\nhost=github.com\npath=acme/repo.git\n\n',
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH ?? '',
        HOME: tmpRun,
        GIT_TERMINAL_PROMPT: '0',
        ...cloneGitEnv('installed-agent', 'https://github.com/acme/repo.git')
      }
    })
    expect(out).toContain('password=installed-agent+get')
  })

  it('pins a repo-local helper that names no helper path, so it reads the same in any filesystem', async () => {
    const argv: string[][] = []
    const runner = {
      withEnv: () => runner,
      raw: async (args: string[]) => {
        argv.push(args)
        return ''
      }
    } as unknown as GitRunner
    await writeRepoHelperConfig(runner)
    const pinned = argv.find((args) => args[1] === '--add')?.[3]
    expect(pinned).toBe(checkoutHelper())
    expect(pinned).not.toContain(SANDBOX_GIT_CREDENTIAL_HELPER)
  })
})

describe('simple-git unsafe checker', () => {
  it('passes the github-app clone env (helper pairs + GIT_CONFIG_COUNT channel)', async () => {
    await expect(
      gitFor(undefined, undefined, { ...gitEnvBase(), ...cloneGitEnv('agent-1') }).raw(['version'])
    ).resolves.toContain('git version')
  })

  it('passes the plain-mode env (sanitized host env + prompt guard)', async () => {
    await expect(
      gitFor(undefined, undefined, { ...workspaceGitEnvBase(), GIT_TERMINAL_PROMPT: '0' }).raw(['version'])
    ).resolves.toContain('git version')
  })

  it('passes the isolated SSH workspace env', async () => {
    await expect(
      gitFor(undefined, undefined, {
        ...workspaceGitEnvBase('ssh://git@github.com/acme/repo.git'),
        GIT_TERMINAL_PROMPT: '0'
      }).raw(['version'])
    ).resolves.toContain('git version')
  })

  it('passes the repo-config helper write (argv channel)', async () => {
    // writeRepoHelperConfig needs a real repo; the argv checker fires before
    // git does, so `-C`-less version probing with the same args shape suffices:
    await expect(
      gitFor()
        .raw(['config', '--get-all', 'credential.https://github.com.helper'])
        .catch((e: Error) => {
          // exit 1 (unset key) is fine — only the unsafe plugin must not trip
          if (/not permitted/.test(e.message)) throw e
          return ''
        })
    ).resolves.toBeDefined()
  })

  it('still refuses the same env without the explicit opt-ins (documents why they exist)', async () => {
    await expect(
      simpleGit()
        .env({ ...gitEnvBase(), ...cloneGitEnv('agent-1') })
        .raw(['version'])
    ).rejects.toThrow(/not permitted/)
  })

  it('still refuses an unsanitized host env (the deployed failure mode)', async () => {
    await expect(
      gitFor(undefined, undefined, { ...process.env, GIT_TERMINAL_PROMPT: '0' }).raw(['version'])
    ).rejects.toThrow(/(EDITOR|GIT_PAGER|PAGER).*not permitted/)
  })
})

describe('gitFor abort wiring', () => {
  it('kills the task when the signal fires (pre-aborted → immediate rejection)', async () => {
    const ac = new AbortController()
    ac.abort()
    await expect(gitFor(undefined, ac.signal).raw(['version'])).rejects.toThrow(/[Aa]bort/)
  })

  it('runs normally with a live (unfired) signal', async () => {
    const ac = new AbortController()
    await expect(gitFor(undefined, ac.signal).raw(['version'])).resolves.toContain('git version')
  })
})

describe('parseGitVersion', () => {
  it('parses plain and vendor-suffixed banners', () => {
    expect(parseGitVersion('git version 2.39.5 (Apple Git-154)\n')).toEqual([2, 39])
    expect(parseGitVersion('git version 2.25.1')).toEqual([2, 25])
    expect(parseGitVersion('git version 3.0.0-rc1')).toEqual([3, 0])
  })

  it('returns null on unrecognizable output', () => {
    expect(parseGitVersion('zsh: command not found: git')).toBeNull()
    expect(parseGitVersion('')).toBeNull()
  })
})

describe("git in a session's runtime", () => {
  it('hands git the placeholder from the environment, and nothing without one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'acp-proxied-git-'))
    const target = sandboxGitCredentialTarget(dir, dir)
    const session = sessionGitConfig('agent-proxied', undefined, target)
    expect(session.content).not.toContain(target.helper)
    // Basic up front, as the proxy's loopback listener requires; git's default waits for a challenge and aborts.
    expect(session.content).toContain('[http]\n\tproxyAuthMethod = basic')
    expect(sessionGitConfig('agent-proxied', undefined, target, null).content).not.toContain('proxyAuthMethod')
    const config = join(dir, 'session.gitconfig')
    writeFileSync(config, session.content)
    const env = {
      PATH: process.env.PATH ?? '',
      HOME: dir,
      GIT_CONFIG_GLOBAL: config,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0'
    }
    const input = 'protocol=https\nhost=github.com\npath=o/r.git\n\n'
    const answer = execFileSync('git', ['credential', 'fill'], {
      input,
      env: { ...env, [CODE_HOST_CREDENTIAL_ENV]: 'acph1_example.tag' }
    }).toString()
    expect(answer).toContain('username=x-access-token')
    expect(answer).toContain('password=acph1_example.tag')
    // A session the proxy cannot reach holds no credential at all.
    expect(() => execFileSync('git', ['credential', 'fill'], { input, env, stdio: 'pipe' })).toThrow()
    rmSync(dir, { recursive: true, force: true })
  })

  it('hands it the placeholder on every pinned instance, a prefixed GitLab and Gitea beside GitHub included', () => {
    const dir = mkdtempSync(join(tmpdir(), 'acp-proxied-git-'))
    const target = sandboxGitCredentialTarget(dir, dir)
    const scope = managedCredentialScope('github', 'https://gitlab.example.test:8443/gitlab', true, {
      host: 'https://gitea.example.test',
      repoBearing: true
    })
    expect(sessionCredentialHosts(scope)).toEqual([
      { provider: 'github', baseUrl: 'https://github.com' },
      { provider: 'gitlab', baseUrl: 'https://gitlab.example.test:8443/gitlab' },
      { provider: 'gitea', baseUrl: 'https://gitea.example.test' }
    ])
    const proxied = sessionGitConfig('agent-proxied', undefined, target, scope)
    expect(proxied.content).not.toContain(target.helper)
    const config = join(dir, 'session.gitconfig')
    writeFileSync(config, proxied.content)
    for (const [host, path] of [
      ['gitlab.example.test:8443', 'gitlab/group/sub/project.git'],
      ['gitea.example.test', 'owner/repo.git']
    ]) {
      const answer = execFileSync('git', ['credential', 'fill'], {
        input: `protocol=https\nhost=${host}\npath=${path}\n\n`,
        env: {
          PATH: process.env.PATH ?? '',
          HOME: dir,
          GIT_CONFIG_GLOBAL: config,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_TERMINAL_PROMPT: '0',
          [CODE_HOST_CREDENTIAL_ENV]: 'acph1_example.tag'
        }
      }).toString()
      expect(answer).toContain('password=acph1_example.tag')
    }
    rmSync(dir, { recursive: true, force: true })
  })

  // Every platform: Git for Windows runs a `!` helper through its bundled sh, and this branch needs only its builtins.
  it("answers the placeholder from the checkout's pin through git's own shell", () => {
    const root = mkdtempSync(join(tmpdir(), 'acp-checkout-pin-'))
    try {
      const local = workspaceGitLocalEnv()
      execFileSync('git', ['init', '-q', root], { env: local })
      execFileSync('git', ['config', '--add', 'credential.https://github.com.helper', checkoutHelper()], {
        cwd: root,
        env: local
      })
      const answer = execFileSync('git', ['credential', 'fill'], {
        cwd: root,
        input: 'protocol=https\nhost=github.com\npath=o/r.git\n\n',
        env: {
          PATH: process.env.PATH ?? '',
          HOME: root,
          GIT_CONFIG_GLOBAL: join(root, 'empty.gitconfig'),
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_COUNT: '0',
          GIT_TERMINAL_PROMPT: '0',
          [CODE_HOST_CREDENTIAL_ENV]: 'acph1_example.tag'
        }
      }).toString()
      expect(answer).toContain('username=x-access-token')
      expect(answer).toContain('password=acph1_example.tag')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  // POSIX only: the stand-in helper is a shell script, and the daemon target's include path is a Windows path there.
  it.skipIf(process.platform === 'win32')(
    "pins a checkout helper that answers the session's placeholder and never the real helper",
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'acp-proxied-checkout-'))
      // The daemon target's helper, standing in for the real one: whatever it answers is the real token.
      const helper = join(tmpRun, 'helper.sh')
      writeFileSync(
        helper,
        '#!/bin/sh\ntest "$2" = get || exit 0\necho username=x-access-token\necho password=REAL-TOKEN-$1\n'
      )
      chmodSync(helper, 0o755)
      const cases = [
        { scope: managedCredentialScope('github'), host: 'github.com', path: 'owner/repo.git' },
        {
          scope: managedCredentialScope('gitlab', 'https://gitlab.example.test:8443/gitlab'),
          host: 'gitlab.example.test:8443',
          path: 'gitlab/group/project.git'
        },
        {
          scope: managedCredentialScope('gitea', undefined, false, { host: 'https://gitea.example.test' }),
          host: 'gitea.example.test',
          path: 'owner/repo.git'
        }
      ]
      try {
        for (const [index, { scope, host, path }] of cases.entries()) {
          const workspace = join(root, `checkout-${index}`)
          const local = workspaceGitLocalEnv()
          execFileSync('git', ['init', '-q', workspace], { env: local })
          const runner = new LocalGitRunner(
            gitFor(workspace, undefined, local),
            workspace,
            (overrides) => gitFor(workspace, undefined, overrides),
            local
          )
          await writeRepoHelperConfig(runner, scope)
          const fill = (session: Record<string, string>) =>
            execFileSync('git', ['credential', 'fill'], {
              cwd: workspace,
              input: `protocol=https\nhost=${host}\npath=${path}\n\n`,
              env: { PATH: process.env.PATH ?? '', HOME: root, GIT_CONFIG_NOSYSTEM: '1', ...session }
            }).toString()
          const placeholder = { [CODE_HOST_CREDENTIAL_ENV]: 'acph1_example.tag' }
          const proxied = sessionGitEnv('agent-checkout', undefined, scope)
          // The checkout's own pin answers, so the session carries no command-scope override.
          expect(proxied.GIT_CONFIG_COUNT).toBeUndefined()
          expect(fill({ ...proxied, ...placeholder })).toContain('password=acph1_example.tag')
          // A child that resets the command-scope pairs still presents the placeholder.
          const reset = { ...proxied, ...placeholder, GIT_CONFIG_COUNT: '0' }
          expect(fill(reset)).toContain('password=acph1_example.tag')
          expect(fill(reset)).not.toContain('REAL-TOKEN')
          // Pairs a session env already carries do not displace the pin.
          const prior = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'safe.directory', GIT_CONFIG_VALUE_0: '*' }
          expect(fill({ ...proxied, ...placeholder, ...prior })).toContain('password=acph1_example.tag')
          // Without a placeholder in the environment neither the pin nor the session config answers.
          expect(() => fill({ ...proxied, GIT_TERMINAL_PROMPT: '0' })).toThrow()
        }
      } finally {
        rmSync(helper, { force: true })
        rmSync(root, { recursive: true, force: true })
      }
    }
  )
})

describe.each([
  {
    name: 'Gitea',
    url: 'https://gitea.example.test:8443/gitea/example-org/example-repo.git',
    path: 'gitea/example-org/example-repo.git',
    scope: managedCredentialScope('gitea', undefined, false, { host: 'https://gitea.example.test:8443/gitea' })
  },
  {
    name: 'GitLab',
    url: 'https://gitea.example.test:8443/gitlab/example-group/sub/example-project.git',
    path: 'gitlab/example-group/sub/example-project.git',
    scope: managedCredentialScope('gitlab', 'https://gitea.example.test:8443/gitlab')
  }
])('a $name repository in an execution environment', ({ url: giteaUrl, path, scope: giteaScope }) => {
  const route = {
    proxyUrl: 'http://codehost:listener-token-example@127.0.0.1:41234',
    trustBundle: '/session/codehost-trust.pem'
  }
  const placeholder = 'acph1_example.tag'

  // POSIX only: the stand-in helper is a shell script.
  it.skipIf(process.platform === 'win32')(
    'takes the proxy route with the placeholder, keeping no real helper or minting capability',
    () => {
      const helper = join(tmpRun, 'helper.sh')
      writeFileSync(
        helper,
        '#!/bin/sh\ntest "$2" = get || exit 0\necho username=example-bot\necho password=REAL-TOKEN\n'
      )
      chmodSync(helper, 0o755)
      const home = mkdtempSync(join(tmpdir(), 'acp-proxied-gitea-git-'))
      const git = (env: Record<string, string>, args: string[], input?: string) =>
        execFileSync('git', args, {
          cwd: home,
          ...(input !== undefined ? { input } : {}),
          env: {
            PATH: process.env.PATH ?? '',
            HOME: home,
            GIT_CONFIG_GLOBAL: join(home, 'empty.gitconfig'),
            GIT_CONFIG_NOSYSTEM: '1',
            ...env
          }
        })
          .toString()
          .trim()
      const fill = (env: Record<string, string>) =>
        git(env, ['credential', 'fill'], `protocol=https\nhost=gitea.example.test:8443\npath=${path}\n\n`)
      try {
        const direct = cloneGitEnv('agent-gitea', giteaUrl, giteaScope)
        expect(fill(direct)).toContain('password=REAL-TOKEN')
        const proxied = proxiedDaemonGitEnv(direct, [giteaScope.host], route, placeholder)
        expect(proxied).not.toHaveProperty(AGENT_CHANNEL_CAPABILITY_ENV)
        expect(JSON.stringify(proxied)).not.toContain(helper)
        expect(fill(proxied)).toContain('password=acph1_example.tag')
        expect(git(proxied, ['config', '--get-urlmatch', 'http.proxy', giteaUrl])).toBe(route.proxyUrl)
        expect(proxied.GIT_SSL_CAINFO).toBe(route.trustBundle)
        expect(() => proxiedDaemonGitEnv(direct, [giteaScope.host], undefined, placeholder)).toThrow(
          'ready credential proxy'
        )
      } finally {
        rmSync(helper, { force: true })
        rmSync(home, { recursive: true, force: true })
      }
    }
  )
})

describe('an Azure DevOps repository beside the workspace', () => {
  const azureUrl = 'https://dev.azure.com/example-org/Example%20Project/_git/Example%20Repo'
  const azureAlias = 'https://example-org.visualstudio.com/Example%20Project/_git/Example%20Repo'
  const githubUrl = 'https://github.com/example-org/example-repo.git'
  const azureScope = managedCredentialScope('azure-devops')
  const githubScope = managedCredentialScope('github', undefined, false, {}, true)
  const servedHosts = [
    githubScope.host,
    azureScope.host,
    { provider: 'azure-devops', baseUrl: 'https://example-org.visualstudio.com' }
  ]
  const route = {
    proxyUrl: 'http://codehost:listener-token-example@127.0.0.1:41234',
    trustBundle: '/session/codehost-trust.pem'
  }
  const placeholder = 'acph1_example.tag'

  it('pins Azure DevOps’s fixed host beside the workspace’s, as a GitLab or Gitea repository pins its instance', () => {
    const azure = { provider: 'azure-devops', baseUrl: 'https://dev.azure.com' }
    expect(sessionCredentialHosts(managedCredentialScope('github', undefined, false, {}, true))).toEqual([
      { provider: 'github', baseUrl: 'https://github.com' },
      azure
    ])
    expect(managedCredentialScope('azure-devops')).toMatchObject({ host: azure, azureDevOpsRepoBearing: true })
    expect(sessionCredentialHosts(managedCredentialScope('azure-devops'))).toEqual([azure])
    expect(sessionCredentialHosts(managedCredentialScope('github'))).toEqual([
      { provider: 'github', baseUrl: 'https://github.com' }
    ])
  })

  it('pins the placeholder on the organization’s own host too, which the proxy serves the same repositories under', () => {
    const dir = mkdtempSync(join(tmpdir(), 'acp-azure-names-'))
    try {
      const target = sandboxGitCredentialTarget(dir, dir)
      const scope = {
        ...managedCredentialScope('azure-devops'),
        proxyNames: ['https://example-org.visualstudio.com', 'https://dev.azure.com']
      }
      const { content } = sessionGitConfig('agent-azure', undefined, target, scope)
      expect(content.split('[credential "https://dev.azure.com"]')).toHaveLength(2)
      expect(content).toContain('[credential "https://example-org.visualstudio.com"]')
      const config = join(dir, 'session.gitconfig')
      writeFileSync(config, content)
      const answer = execFileSync('git', ['credential', 'fill'], {
        input: 'protocol=https\nhost=example-org.visualstudio.com\npath=Example Project/_git/Example Repo\n\n',
        env: {
          PATH: process.env.PATH ?? '',
          HOME: dir,
          GIT_CONFIG_GLOBAL: config,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_TERMINAL_PROMPT: '0',
          [CODE_HOST_CREDENTIAL_ENV]: 'acph1_example.tag'
        }
      }).toString()
      expect(answer).toContain('password=acph1_example.tag')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // POSIX only: the stand-in helper is a shell script.
  it.skipIf(process.platform === 'win32')(
    'selects the operation target in a mixed agent and removes every real helper from a migrated invocation',
    () => {
      const helper = join(tmpRun, 'helper.sh')
      writeFileSync(
        helper,
        '#!/bin/sh\ntest "$2" = get || exit 0\necho username=x-access-token\necho password=REAL-TOKEN\n'
      )
      chmodSync(helper, 0o755)
      const home = mkdtempSync(join(tmpdir(), 'acp-proxied-daemon-git-'))
      const fill = (env: Record<string, string>, host: string) =>
        execFileSync('git', ['credential', 'fill'], {
          input: `protocol=https\nhost=${host}\npath=example-org/Example Project/_git/Example Repo\n\n`,
          env: {
            PATH: process.env.PATH ?? '',
            HOME: home,
            GIT_CONFIG_GLOBAL: join(home, 'empty.gitconfig'),
            GIT_CONFIG_NOSYSTEM: '1',
            ...env
          }
        }).toString()
      try {
        const azure = cloneGitEnv('agent-azure', azureUrl, azureScope)
        expect(fill(azure, 'dev.azure.com')).toContain('password=REAL-TOKEN')
        const github = cloneGitEnv('agent-azure', githubUrl, githubScope)
        const both = { ...azure, ...mergeGitConfigEnv(azure, github) }
        const proxied = proxiedDaemonGitEnv(both, servedHosts, route, placeholder)
        expect(proxied).not.toHaveProperty(AGENT_CHANNEL_CAPABILITY_ENV)
        expect(fill(proxied, 'dev.azure.com')).toContain('password=acph1_example.tag')
        expect(fill(proxied, 'example-org.visualstudio.com')).toContain('password=acph1_example.tag')
        expect(fill(proxied, 'github.com')).toContain('password=acph1_example.tag')
        expect(JSON.stringify(proxied)).not.toContain(helper)
        // An Azure additional repository selects the proxy even when the injected scope starts with GitHub.
        const additional = cloneGitEnv('agent-azure', azureUrl, githubScope)
        expect(fill(proxiedDaemonGitEnv(additional, servedHosts, route, placeholder), 'dev.azure.com')).toContain(
          'password=acph1_example.tag'
        )
        expect(proxiedDaemonGitEnv(github, servedHosts, undefined, undefined)).toBe(github)
        expect(fill(github, 'github.com')).toContain('password=REAL-TOKEN')
        const local = workspaceGitLocalEnv()
        expect(proxiedDaemonGitEnv(local, servedHosts, undefined, undefined)).toBe(local)
      } finally {
        rmSync(helper, { force: true })
        rmSync(home, { recursive: true, force: true })
      }
    }
  )

  it('pins the canonical remote to its proxy while bundle storage stays direct and inherited bypasses disappear', () => {
    const home = mkdtempSync(join(tmpdir(), 'acp-proxied-git-route-'))
    try {
      execFileSync('git', ['init', '-q', home], { env: workspaceGitLocalEnv() })
      const target = workspaceGitRemoteTarget(azureAlias, 'agent-azure', azureScope)
      const proxied = proxiedDaemonGitEnv(
        {
          ...target.env,
          NO_PROXY: 'dev.azure.com',
          no_proxy: '*',
          HTTPS_PROXY: 'http://unrelated.example.test:8080'
        },
        servedHosts,
        route,
        placeholder
      )
      const read = (args: string[]) =>
        execFileSync('git', args, {
          cwd: home,
          env: { ...proxied, HOME: home, GIT_CONFIG_GLOBAL: join(home, 'empty.gitconfig') }
        })
          .toString()
          .trim()
      expect(read(['ls-remote', '--get-url', target.remote])).toBe(azureUrl)
      expect(read(['config', '--get', `remote.${target.remote}.proxy`])).toBe(route.proxyUrl)
      expect(read(['config', '--get-urlmatch', 'http.proxy', azureUrl])).toBe(route.proxyUrl)
      expect(read(['config', '--get-urlmatch', 'http.proxy', 'https://objects.example.test/clone.bundle'])).toBe('')
      expect(read(['config', '--get-urlmatch', 'http.sslVerify', azureUrl])).toBe('true')
      expect(proxied.GIT_SSL_CAINFO).toBe(route.trustBundle)
      expect(proxied).not.toHaveProperty(AGENT_CHANNEL_CAPABILITY_ENV)
      for (const name of ['NO_PROXY', 'no_proxy', 'HTTPS_PROXY']) expect(proxied).not.toHaveProperty(name)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('requires a ready route covering every target, including the domains reported by SRT', () => {
    const azure = cloneGitEnv('agent-azure', azureUrl, azureScope)
    expect(() => proxiedDaemonGitEnv(azure, servedHosts, undefined, placeholder)).toThrow('ready credential proxy')
    expect(() => proxiedDaemonGitEnv(azure, servedHosts, route, undefined)).toThrow('ready credential proxy')
    const uncovered = workspaceGitEnvBase('https://unserved.example.test/example-repo.git')
    const multiple = { ...azure, ...mergeGitConfigEnv(azure, uncovered) }
    expect(() => proxiedDaemonGitEnv(multiple, servedHosts, route, placeholder)).toThrow('not covered')
    expect(() =>
      proxiedDaemonGitEnv(azure, servedHosts, { trustBundle: route.trustBundle, domains: ['github.com'] }, placeholder)
    ).toThrow('not covered')
    const transparent = proxiedDaemonGitEnv(
      azure,
      servedHosts,
      { trustBundle: route.trustBundle, domains: ['dev.azure.com'] },
      placeholder
    )
    expect(transparent[CODE_HOST_CREDENTIAL_ENV]).toBe(placeholder)
    expect(transparent).not.toHaveProperty(AGENT_CHANNEL_CAPABILITY_ENV)
  })
})
