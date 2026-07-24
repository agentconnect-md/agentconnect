import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { simpleGit } from 'simple-git'
import { GITCRED_AGENT_ENV, GITCRED_CAPABILITY_ENV } from '../src/cp/gitcred-server.js'
import {
  assertSafeWorkspaceGitConfig,
  cloneGitEnv,
  gitEnvBase,
  gitFor,
  initGitInjection,
  parseGitVersion,
  pullWorkspaceRef,
  sessionGitEnv,
  workspaceGitEnvBase,
  workspaceGitLocalEnv,
  workspaceGitPullTarget
} from '../src/workspace/git-injection.js'

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
    shimPath: join(tmpRun, 'helper.sh'),
    runDir: tmpRun,
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
      GIT_LFS_SKIP_SMUDGE: '1',
      GIT_NO_LAZY_FETCH: '1'
    })
    expect(workspaceGitEnvBase().GIT_CONFIG_GLOBAL).toBe(process.platform === 'win32' ? 'NUL' : '/dev/null')
    expect(Object.keys(workspaceGitEnvBase()).some((key) => /^(?:all|ftp|http|https|no)_proxy$/i.test(key))).toBe(false)
    expect(configPairs(workspaceGitEnvBase())).toContainEqual(['http.followRedirects', 'false'])
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
    const cleanEnv = workspaceGitEnvBase()
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
        gitFor(workspace).env(workspaceGitEnvBase()).raw(['remote', 'get-url', 'origin'])
      ).resolves.toContain('https://other-host.example/acme/repo')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps redirects disabled when repo-local URL config tries to re-enable them', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'git-redirect-policy-test-'))
    const repository = 'https://github.com/acme/repo.git'
    try {
      const cleanEnv = workspaceGitEnvBase()
      execFileSync('git', ['init', workspace], { env: cleanEnv, stdio: 'ignore' })
      execFileSync('git', ['-C', workspace, 'config', `http.${repository}.followRedirects`, 'true'], {
        env: cleanEnv
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
      await expect(assertSafeWorkspaceGitConfig(workspace)).rejects.toThrow(/disallowed network override/)
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

      const target = workspaceGitPullTarget(repository)
      expect(target.remote).toMatch(/^agentconnect-[0-9a-f-]+$/)
      expect(configPairs(target.env)).toContainEqual([`remote.${target.remote}.url`, ''])
      expect(configPairs(target.env)).toContainEqual([`remote.${target.remote}.url`, repository])
      expect(configPairs(target.env)).toContainEqual([`remote.${target.remote}.proxy`, ''])
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
      await expect(assertSafeWorkspaceGitConfig(workspace)).rejects.toThrow(/disallowed network override/)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('updates the origin tracking ref when an explicit URL pull advances HEAD', async () => {
    const root = mkdtempSync(join(tmpdir(), 'git-pull-refspec-test-'))
    const remote = join(root, 'remote.git')
    const seed = join(root, 'seed')
    const workspace = join(root, 'workspace')
    const env = { ...workspaceGitEnvBase(), GIT_ALLOW_PROTOCOL: 'file:https:ssh' }
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
      await pullWorkspaceRef(git, 'origin', 'main')

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

describe('sessionGitEnv', () => {
  it('pins the CP-provided bot as both author and committer', () => {
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
