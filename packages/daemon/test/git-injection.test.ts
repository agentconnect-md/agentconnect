import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { simpleGit } from 'simple-git'
import { GITCRED_AGENT_ENV, GITCRED_CAPABILITY_ENV, GITCRED_SOCKET_ENV } from '../src/cp/gitcred-server.js'
import { LocalGitRunner, type GitRunner } from '../src/workspace/git-runner.js'
import {
  assertSafeWorkspaceGitConfig,
  canonicalWorkspaceGitUrl,
  cloneGitEnv,
  gitEnvBase,
  gitFor,
  daemonGitCredentialTarget,
  initGitInjection,
  parseGitVersion,
  pullWorkspaceRef,
  sandboxGitCredentialTarget,
  sessionGitConfig,
  sessionGitEnv,
  workspaceGitEnvBase,
  workspaceGitLocalEnv,
  workspaceGitRemoteTarget,
  writeRepoHelperConfig
} from '../src/workspace/git-injection.js'
import { SANDBOX_GIT_CONFIG_DIR, SANDBOX_GIT_CREDENTIAL_HELPER } from '../src/shim/sandbox-paths.js'
import { SANDBOX_TUNNEL_PATHS } from '../src/shim/tunnel.js'

// simple-git ≥3.36 refuses a NAME blocklist of env vars (presence-based, value
// never read) and requires opt-ins for credential.helper / GIT_CONFIG_COUNT.
// These tests spawn real git (`raw(['version'])`, no network) through the same
// plugin pipeline the daemon's clone/pull use — a green run here is exactly
// "the deployed daemon would not have thrown before git even started".

const POLLUTED = {
  [GITCRED_CAPABILITY_ENV]: 'host-capability',
  [GITCRED_AGENT_ENV]: 'host-agent-id', // a stale host value must never outrank the minted pair
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

// The audit takes a runner: it must read the config the git it guards reads, which for a cluster
// workspace is the sandbox's filesystem rather than this one.
function localRunner(cwd: string): GitRunner {
  return new LocalGitRunner(gitFor(cwd), cwd, (env) => gitFor(cwd).env(env))
}

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
    targetFor: (agentId) =>
      agentId.startsWith('pod-')
        ? sandboxGitCredentialTarget()
        : daemonGitCredentialTarget({ shimPath: join(tmpRun, 'helper.sh'), runDir: tmpRun }),
    preWarm: async () => undefined,
    capabilityFor: (agentId) => `cap-${agentId}`
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
        gitFor(workspace).env(workspaceGitLocalEnv()).raw(['remote', 'get-url', 'origin'])
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

  it('pins a full target against broader URL rewrites and rejects checkout-owned rewrites', async () => {
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
      await expect(assertSafeWorkspaceGitConfig(localRunner(workspace))).rejects.toThrow(/disallowed network override/)
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

  it('rejects a checkout-owned incremental bundle URI before pull', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'git-bundle-policy-test-'))
    try {
      execFileSync('git', ['init', workspace], { env: workspaceGitLocalEnv(), stdio: 'ignore' })
      execFileSync('git', ['-C', workspace, 'config', 'fetch.bundleURI', 'https://127.0.0.1/private.bundle'], {
        env: workspaceGitLocalEnv()
      })
      await expect(assertSafeWorkspaceGitConfig(localRunner(workspace))).rejects.toThrow(/disallowed network override/)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it(`audits the config of the filesystem the RUNNER reaches, not this daemon's disk`, async () => {
    // Why the audit takes a runner: a cluster workspace's config lives on the sandbox pod, so a
    // check performed here is performed on the wrong machine — passing while the real config is
    // hostile.
    const workspace = mkdtempSync(join(tmpdir(), 'git-audit-filesystem-'))
    const localEnv = workspaceGitLocalEnv()
    try {
      // Locally CLEAN...
      execFileSync('git', ['init', workspace], { env: localEnv, stdio: 'ignore' })
      await expect(assertSafeWorkspaceGitConfig(localRunner(workspace))).resolves.toBeUndefined()

      // ...while the runner's filesystem reports a hostile setting: the audit must follow it.
      const hostile: GitRunner = {
        withEnv: () => hostile,
        raw: async () => 'filter.generated.process\0',
        clone: async () => undefined,
        pull: async () => ({ files: [], insertions: 0, deletions: 0 }),
        status: async () => ({ current: null, tracking: null, ahead: 0, behind: 0, files: [], clean: true }),
        log: async () => [],
        readBounded: async () => ({ out: Buffer.alloc(0), overflow: false })
      }
      await expect(assertSafeWorkspaceGitConfig(hostile)).rejects.toThrow(/executable setting/)

      // The converse proves the local disk is not consulted: unsafe LOCAL, clean runner, passes.
      execFileSync('git', ['-C', workspace, 'config', 'filter.generated.process', './evil'], { env: localEnv })
      await expect(assertSafeWorkspaceGitConfig(localRunner(workspace))).rejects.toThrow(/executable setting/)
      const clean: GitRunner = { ...hostile, withEnv: () => clean, raw: async () => '' }
      await expect(assertSafeWorkspaceGitConfig(clean)).resolves.toBeUndefined()
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('rejects checkout-owned executable Git settings that daemon policy does not override', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'git-executable-config-test-'))
    const localEnv = workspaceGitLocalEnv()
    try {
      execFileSync('git', ['init', workspace], { env: localEnv, stdio: 'ignore' })
      execFileSync('git', ['-C', workspace, 'config', 'filter.generated.process', './filter-process'], {
        env: localEnv
      })
      await expect(assertSafeWorkspaceGitConfig(localRunner(workspace))).rejects.toThrow(/executable setting/)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('allows an included hooksPath while still auditing included network overrides', async () => {
    const root = mkdtempSync(join(tmpdir(), 'git-included-hook-policy-test-'))
    const workspace = join(root, 'workspace')
    const include = join(root, 'workspace.gitconfig')
    const localEnv = workspaceGitLocalEnv()
    try {
      execFileSync('git', ['init', workspace], { env: localEnv, stdio: 'ignore' })
      writeFileSync(include, '[core]\n\thooksPath = .github/.githooks\n')
      execFileSync('git', ['-C', workspace, 'config', 'include.path', include], { env: localEnv })
      await expect(assertSafeWorkspaceGitConfig(localRunner(workspace))).resolves.toBeUndefined()

      writeFileSync(
        include,
        '[core]\n\thooksPath = .github/.githooks\n[url "https://127.0.0.1.invalid/"]\n\tinsteadOf = https://github.com/\n'
      )
      await expect(assertSafeWorkspaceGitConfig(localRunner(workspace))).rejects.toThrow(/disallowed network override/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects conditional includes that can activate only in a linked worktree', async () => {
    const root = mkdtempSync(join(tmpdir(), 'git-conditional-include-policy-test-'))
    const workspace = join(root, 'workspace')
    const include = join(root, 'worktree.gitconfig')
    const localEnv = workspaceGitLocalEnv()
    try {
      execFileSync('git', ['init', workspace], { env: localEnv, stdio: 'ignore' })
      writeFileSync(include, '[filter "evil"]\n\tprocess = ./filter-process\n')
      execFileSync('git', ['-C', workspace, 'config', 'includeIf.gitdir:**/.git/worktrees/**.path', include], {
        env: localEnv
      })

      await expect(assertSafeWorkspaceGitConfig(localRunner(workspace))).rejects.toThrow(/executable setting/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects the separate worktree config scope omitted by a local-scope audit', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'git-worktree-config-policy-test-'))
    const localEnv = workspaceGitLocalEnv()
    try {
      execFileSync('git', ['init', workspace], { env: localEnv, stdio: 'ignore' })
      execFileSync('git', ['-C', workspace, 'config', 'extensions.worktreeConfig', 'true'], { env: localEnv })
      writeFileSync(join(workspace, '.git', 'config.worktree'), '[filter "evil"]\n\tsmudge = ./filter-smudge\n')

      await expect(assertSafeWorkspaceGitConfig(localRunner(workspace))).rejects.toThrow(/executable setting/)
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

  it('updates the origin tracking ref when an explicit URL pull advances HEAD', async () => {
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

      const git = gitFor(workspace).env(env)
      const runner = new LocalGitRunner(git, workspace, (overrides) => gitFor(workspace).env(overrides), env)
      await pullWorkspaceRef(runner, 'origin', 'main')

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
    expect(cloneGitEnv('agent-1')[GITCRED_CAPABILITY_ENV]).toBe('cap-agent-1')
    const session = sessionGitEnv('agent-1')
    expect(session[GITCRED_CAPABILITY_ENV]).toBe('cap-agent-1')
    expect(readFileSync(session.GIT_CONFIG_GLOBAL!, 'utf8')).not.toContain('cap-agent-1')
  })

  it('mints the env identity as a pair with the capability (helper outranks config-embedded ids)', () => {
    expect(cloneGitEnv('agent-1')[GITCRED_AGENT_ENV]).toBe('agent-1')
    expect(sessionGitEnv('agent-1')[GITCRED_AGENT_ENV]).toBe('agent-1')
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
    expect(target.env[GITCRED_CAPABILITY_ENV]).toBe('cap-agent-1')
    expect(target.env[GITCRED_AGENT_ENV]).toBe('agent-1')
  })

  it('omits the helper entirely for a workspace the daemon issues no credentials for', () => {
    const target = workspaceGitRemoteTarget('ssh://git@github.com/acme/repo.git')
    const pairs = configPairs(target.env)
    expect(pairs.some(([key]) => key === 'credential.https://github.com.helper')).toBe(false)
    expect(target.env[GITCRED_CAPABILITY_ENV]).toBeUndefined()
    // Still the full hardening set — an ssh target keeps its pinned command and no user routing.
    expect(pairs).toContainEqual(['core.hooksPath', process.platform === 'win32' ? 'NUL' : '/dev/null'])
    expect(pairs).toContainEqual(['ssh.variant', 'ssh'])
  })

  it('passes the simple-git unsafe checker for the argv it produces', async () => {
    // Same guarantee the clone env gets: the credential-helper pairs and the GIT_CONFIG_COUNT
    // channel each need an opt-in, and only handles built by `gitFor` carry it.
    const target = workspaceGitRemoteTarget('https://github.com/acme/repo.git', 'agent-1')
    await expect(gitFor().env(target.env).raw(['version'])).resolves.toContain('git version')
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
    expect(env[GITCRED_CAPABILITY_ENV]).toBeUndefined()
    expect(env[GITCRED_AGENT_ENV]).toBeUndefined()
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
      `!'${SANDBOX_GIT_CREDENTIAL_HELPER}' pod-agent`
    ])
    // The helper has no daemon root to derive a socket from, so the tunnel's path travels with it.
    expect(cloneGitEnv('pod-agent')[GITCRED_SOCKET_ENV]).toBe(SANDBOX_TUNNEL_PATHS.gitcred)
    expect(JSON.stringify(pairs)).not.toContain(tmpRun)
  })

  it('keeps the daemon-local pointers exactly as they were', () => {
    // The regression guard for every self-hosted daemon: this path is the one in production today.
    const pairs = configPairs(cloneGitEnv('agent-1', 'https://github.com/acme/repo.git'))
    expect(pairs).toContainEqual(['credential.https://github.com.helper', `!'${join(tmpRun, 'helper.sh')}' agent-1`])
    expect(cloneGitEnv('agent-1')).not.toHaveProperty(GITCRED_SOCKET_ENV)
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
    expect(pod.env[GITCRED_SOCKET_ENV]).toBe(SANDBOX_TUNNEL_PATHS.gitcred)
    expect(pod.content).toContain(`!'${SANDBOX_GIT_CREDENTIAL_HELPER}' agent-1`)
    expect(pod.content).not.toContain(homedir())
  })

  it('refuses to WRITE a pod gitconfig, rather than writing it here', () => {
    // The whole class of bug in one assertion: a synchronous write of `/run/agentconnect/...`
    // lands on the daemon's disk, creating the file a check would look for while the pod has none.
    expect(() => sessionGitEnv('pod-agent')).toThrow(/materialize its gitconfig/)
    expect(existsSync(join(SANDBOX_GIT_CONFIG_DIR, 'pod-agent.gitconfig'))).toBe(false)
  })

  it('writes the repo-local helper in the coordinates of the git that will read it', async () => {
    const argv: string[][] = []
    const runner = {
      withEnv: () => runner,
      raw: async (args: string[]) => {
        argv.push(args)
        return ''
      }
    } as unknown as GitRunner
    await writeRepoHelperConfig(runner, 'pod-agent')
    // `.git/config` outlives a launch, so this is the pointer a later agent-run git in the pod
    // finds on disk — it has to name the image's helper too, not just the spawn env.
    expect(argv).toContainEqual([
      'config',
      '--add',
      'credential.https://github.com.helper',
      `!'${SANDBOX_GIT_CREDENTIAL_HELPER}' pod-agent`
    ])
  })
})

describe('simple-git unsafe checker', () => {
  it('passes the github-app clone env (helper pairs + GIT_CONFIG_COUNT channel)', async () => {
    await expect(
      gitFor()
        .env({ ...gitEnvBase(), ...cloneGitEnv('agent-1') })
        .raw(['version'])
    ).resolves.toContain('git version')
  })

  it('passes the plain-mode env (sanitized host env + prompt guard)', async () => {
    await expect(
      gitFor()
        .env({ ...workspaceGitEnvBase(), GIT_TERMINAL_PROMPT: '0' })
        .raw(['version'])
    ).resolves.toContain('git version')
  })

  it('passes the isolated SSH workspace env', async () => {
    await expect(
      gitFor()
        .env({ ...workspaceGitEnvBase('ssh://git@github.com/acme/repo.git'), GIT_TERMINAL_PROMPT: '0' })
        .raw(['version'])
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
      gitFor()
        .env({ ...process.env, GIT_TERMINAL_PROMPT: '0' })
        .raw(['version'])
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
