import { describe, it, expect } from 'vitest'
import { mkdtempSync, existsSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assertAccountName,
  currentAccount,
  lookupAccount,
  repairRootOwnership,
  rootOwnershipPaths,
  sudoAccountName
} from '../src/service/account.js'
import {
  buildPolkitRule,
  POLKIT_VERBS,
  polkitRulePath,
  polkitRulesSupported,
  removePolkitRule,
  writePolkitRule
} from '../src/service/polkit.js'
import { elevate, elevatedArgs, findOnPath, manualSudoCommand, type ElevateDeps } from '../src/service/elevate.js'

const posix = it.skipIf(process.platform === 'win32')
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p))
const ACCOUNT = { user: 'agent', uid: 1000, gid: 1000, home: '/home/agent' }

describe('account', () => {
  it('rejects names that are not valid unix accounts', () => {
    // The name is interpolated into a polkit rule, so it is validated, not escaped.
    for (const bad of ["a'; return polkit.Result.YES; //", '1agent', 'a b', '', 'x'.repeat(33)]) {
      expect(() => assertAccountName(bad)).toThrow(/invalid account name/)
    }
    expect(assertAccountName('agent_1-x')).toBe('agent_1-x')
  })

  it('reads the sudo account only when both SUDO_USER and SUDO_UID are present', () => {
    expect(sudoAccountName({ SUDO_USER: 'agent', SUDO_UID: '1000' })).toBe('agent')
    // A bare SUDO_USER can be inherited from an unrelated outer sudo.
    expect(sudoAccountName({ SUDO_USER: 'agent' })).toBeUndefined()
    expect(sudoAccountName({})).toBeUndefined()
  })

  posix('looks an account up out of the passwd database', () => {
    const found = lookupAccount('root')
    expect(found?.user).toBe('root')
    expect(found?.uid).toBe(0)
    expect(lookupAccount('no-such-account-here')).toBeUndefined()
  })

  posix('describes the invoking account', () => {
    expect(currentAccount().user.length).toBeGreaterThan(0)
  })
})

describe('polkit rule', () => {
  it('names the file so it sorts ahead of polkit defaults', () => {
    // `49-` beats polkit's shipped `50-default.rules`; joined so the assertion
    // holds on the Windows unit-test leg too.
    expect(polkitRulePath('agentconnect.service', '/r')).toBe(join('/r', '49-agentconnect.rules'))
    expect(polkitRulePath('agentconnect@dev.service', '/r')).toBe(join('/r', '49-agentconnect@dev.rules'))
  })

  it('grants exactly one unit, one account, and the lifecycle verbs', () => {
    const rule = buildPolkitRule({ unitLabel: 'agentconnect@dev.service', user: 'agent' })
    expect(rule).toContain("action.id === 'org.freedesktop.systemd1.manage-units'")
    expect(rule).toContain("action.lookup('unit') === 'agentconnect@dev.service'")
    expect(rule).toContain("subject.user === 'agent'")
    for (const verb of POLKIT_VERBS) expect(rule).toContain(`'${verb}'`)
    // Boot persistence is an install-time decision and stays root-only.
    expect(rule).not.toContain("'enable'")
    expect(rule).not.toContain("'disable'")
  })

  it('refuses to build a rule for a name it cannot vouch for', () => {
    expect(() => buildPolkitRule({ unitLabel: 'agentconnect.service', user: "x' || true || '" })).toThrow(
      /invalid account name/
    )
  })

  it('writes and removes its own file only', () => {
    const dir = tmp('ac-polkit-')
    const path = writePolkitRule({ unitLabel: 'agentconnect@dev.service', user: 'agent', dir })
    expect(readFileSync(path, 'utf8')).toContain('polkit.addRule')
    removePolkitRule('agentconnect.service', dir) // a different instance — untouched
    expect(existsSync(path)).toBe(true)
    removePolkitRule('agentconnect@dev.service', dir)
    expect(existsSync(path)).toBe(false)
  })

  it('detects a host with no rules.d backend', () => {
    expect(polkitRulesSupported(tmp('ac-polkit-'))).toBe(true)
    expect(polkitRulesSupported(join(tmp('ac-polkit-'), 'absent'))).toBe(false)
  })

  posix('lands world-readable even under a restrictive umask', () => {
    // polkitd runs as the unprivileged `polkitd` user, and writeFileSync's `mode`
    // is masked by the umask — a 0600 rule is silently never consulted.
    const previous = process.umask(0o077)
    try {
      const path = writePolkitRule({ unitLabel: 'agentconnect.service', user: 'agent', dir: tmp('ac-polkit-') })
      expect((statSync(path).mode & 0o777).toString(8)).toBe('644')
    } finally {
      process.umask(previous)
    }
  })
})

describe('root ownership after an elevated install', () => {
  const ACCT = { user: 'agent', uid: 1000, gid: 1000, home: '/home/agent' }

  it('names the root itself plus the two pointer files', () => {
    expect(rootOwnershipPaths('/home/agent/.agentconnect')).toEqual([
      '/home/agent/.agentconnect',
      join('/home/agent/.agentconnect', 'cli-entry'),
      join('/home/agent/.agentconnect', 'service.json')
    ])
  })

  it('hands back only what this elevated process left root-owned', () => {
    const chowned: Array<[string, number, number]> = []
    // The root was created by the elevated cli-entry self-heal (0700, uid 0); the
    // pointer file predates this install and already belongs to the account.
    const owners: Record<string, number> = {
      '/r': 0,
      [join('/r', 'cli-entry')]: 1000,
      [join('/r', 'service.json')]: 0
    }
    const repaired = repairRootOwnership('/r', ACCT, {
      chown: (p, uid, gid) => chowned.push([p, uid, gid]),
      ownerOf: (p) => owners[p]
    })
    expect(repaired).toEqual(['/r', join('/r', 'service.json')])
    expect(chowned).toEqual([
      ['/r', 1000, 1000],
      [join('/r', 'service.json'), 1000, 1000]
    ])
  })

  it('does nothing when the daemon account IS root', () => {
    const chowned: string[] = []
    const repaired = repairRootOwnership(
      '/r',
      { ...ACCT, uid: 0, gid: 0 },
      {
        chown: (p) => chowned.push(p),
        ownerOf: () => 0
      }
    )
    expect([repaired, chowned]).toEqual([[], []])
  })

  it('skips a path it cannot chown rather than failing the install', () => {
    const repaired = repairRootOwnership('/r', ACCT, {
      chown: () => {
        throw new Error('EPERM')
      },
      ownerOf: () => 0
    })
    expect(repaired).toEqual([])
  })
})

describe('elevate', () => {
  const req = {
    command: 'install-service' as const,
    root: '/home/agent/.agentconnect',
    instance: 'dev',
    account: ACCOUNT,
    envPath: '/usr/local/bin:/usr/bin'
  }

  const deps = (over: Partial<ElevateDeps> = {}): ElevateDeps & { ran: string[][] } => {
    const ran: string[][] = []
    return {
      execPath: '/usr/bin/node',
      cliEntry: '/opt/ac/cli.js',
      hasSudo: () => true,
      sudoNonInteractiveOk: () => true,
      runSudo: (args) => {
        ran.push(args)
        return 0
      },
      isTTY: true,
      elevated: () => false,
      ran,
      ...over
    }
  }

  it('rebuilds the argv from resolved intent rather than rewriting the caller-s', () => {
    // Nothing from the original command line crosses the sudo boundary, so no
    // option-parsing quirk can smuggle an extra flag into the root process.
    expect(elevatedArgs(req)).toEqual([
      'install-service',
      '--root',
      '/home/agent/.agentconnect',
      '--instance',
      'dev',
      '--service-user',
      'agent',
      '--service-home',
      '/home/agent',
      '--service-path',
      '/usr/local/bin:/usr/bin'
    ])
  })

  it('carries the PATH snapshot across, since sudo replaces PATH with secure_path', () => {
    expect(elevatedArgs(req)).toContain('--service-path')
    expect(elevatedArgs({ ...req, envPath: undefined as unknown as string })).not.toContain('--service-path')
  })

  it('does nothing when already root', () => {
    const d = deps({ elevated: () => true })
    expect(elevate(req, d)).toEqual({ elevated: true })
    expect(d.ran).toEqual([])
  })

  it('re-runs itself under sudo and reports the child exit code', () => {
    const d = deps({ runSudo: (args) => (args.includes('install-service') ? 7 : 0) })
    expect(elevate(req, d)).toEqual({ elevated: false, code: 7 })
  })

  it('passes the absolute node and CLI paths after `--`', () => {
    const d = deps()
    elevate(req, d)
    expect(d.ran[0]?.slice(0, 3)).toEqual(['--', '/usr/bin/node', '/opt/ac/cli.js'])
  })

  it('names the manual command when sudo is missing', () => {
    expect(() => elevate(req, deps({ hasSudo: () => false }))).toThrow(/sudo was not found[\s\S]*install-service/)
  })

  it('refuses rather than hanging when a password is needed with no terminal', () => {
    // sudo reads the password from /dev/tty; with no TTY it would block forever.
    const d = deps({ sudoNonInteractiveOk: () => false, isTTY: false })
    expect(() => elevate(req, d)).toThrow(/no terminal to prompt on/)
    expect(d.ran).toEqual([])
  })

  it('prompts on a terminal when sudo needs a password', () => {
    const d = deps({ sudoNonInteractiveOk: () => false, isTTY: true })
    expect(elevate(req, d)).toEqual({ elevated: false, code: 0 })
    expect(d.ran).toHaveLength(1)
  })

  it('quotes the manual command so it can be pasted back into a shell', () => {
    const line = manualSudoCommand('/usr/bin/node', '/opt/ac/cli.js', {
      ...req,
      root: '/home/agent/my root'
    })
    expect(line).toContain(`'/home/agent/my root'`)
    expect(line.startsWith('sudo -- /usr/bin/node /opt/ac/cli.js install-service')).toBe(true)
  })

  posix('finds a binary on PATH', () => {
    expect(findOnPath('sh', { PATH: '/nope:/bin:/usr/bin' })).toMatch(/\/sh$/)
    expect(findOnPath('definitely-not-a-binary', { PATH: '/bin' })).toBeUndefined()
  })
})
