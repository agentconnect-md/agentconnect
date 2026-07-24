import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { simpleGit } from 'simple-git'
import { GITCRED_AGENT_ENV, GITCRED_CAPABILITY_ENV } from '../src/cp/gitcred-server.js'
import {
  cloneGitEnv,
  gitEnvBase,
  gitFor,
  initGitInjection,
  parseGitVersion,
  sessionGitEnv
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
  GIT_DIR: '/elsewhere/.git',
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'core.editor',
  GIT_CONFIG_VALUE_0: 'vim'
} as const

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
    for (const k of Object.keys(POLLUTED)) expect(env, k).not.toHaveProperty(k)
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
        .env({ ...gitEnvBase(), GIT_TERMINAL_PROMPT: '0' })
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
