import { describe, it, expect } from 'vitest'
import {
  classifyInvocation,
  firstPositional,
  parseInstanceFlag,
  parseRootFlag,
  withResolvedRoot
} from '../src/route.js'

describe('firstPositional', () => {
  it('finds a bare command', () => {
    expect(firstPositional(['chat'])).toBe('chat')
  })
  it('skips a value-taking global option and its value', () => {
    expect(firstPositional(['--root', '/tmp/ac', 'chat'])).toBe('chat')
    expect(firstPositional(['--api-url', 'wss://api.example/daemon/ws', 'run'])).toBe('run')
  })
  it('handles the --opt=value form (no separate value token)', () => {
    expect(firstPositional(['--root=/tmp/ac', 'chat'])).toBe('chat')
  })
  it('does not skip a token after a boolean flag', () => {
    expect(firstPositional(['--dry-run', 'run'])).toBe('run')
  })
  it('treats everything after -- as positional', () => {
    expect(firstPositional(['--', 'chat'])).toBe('chat')
  })
  it('returns undefined when there is no command', () => {
    expect(firstPositional([])).toBeUndefined()
    expect(firstPositional(['--help'])).toBeUndefined()
    expect(firstPositional(['--root', '/tmp/ac'])).toBeUndefined()
  })
})

describe('classifyInvocation', () => {
  it('routes the foreground run shell', () => {
    expect(classifyInvocation(['run'])).toBe('run')
    expect(classifyInvocation(['--root', '/x', 'run'])).toBe('run')
  })

  it('delegates daemon-owned commands, with global options on either side', () => {
    expect(classifyInvocation(['chat'])).toBe('delegate')
    expect(classifyInvocation(['--root', '/tmp/ac', 'chat'])).toBe('delegate')
    expect(classifyInvocation(['chat', '--root', '/tmp/ac'])).toBe('delegate')
    expect(classifyInvocation(['agent', 'list'])).toBe('delegate')
    expect(classifyInvocation(['git-credential', 'a1', 'get'])).toBe('delegate')
  })

  it('delegates unknown/future daemon commands without a CLI change', () => {
    expect(classifyInvocation(['some-future-command'])).toBe('delegate')
    expect(classifyInvocation(['--root=/x', 'brand-new-thing'])).toBe('delegate')
  })

  it('keeps CLI-owned commands on the CLI', () => {
    for (const c of [
      'up',
      'down',
      'restart',
      'status',
      'install',
      'install-service',
      'uninstall-service',
      'login',
      'upgrade'
    ]) {
      expect(classifyInvocation([c])).toBe('cli')
    }
    expect(classifyInvocation(['--root', '/x', 'login'])).toBe('cli')
    expect(classifyInvocation(['version', 'list'])).toBe('cli')
  })

  it('keeps bare / help / version invocations on the CLI', () => {
    expect(classifyInvocation([])).toBe('cli')
    expect(classifyInvocation(['--help'])).toBe('cli')
    expect(classifyInvocation(['--version'])).toBe('cli')
    expect(classifyInvocation(['help'])).toBe('cli')
  })
})

describe('parseRootFlag', () => {
  it('reads the global root in both forms, before or after the command', () => {
    expect(parseRootFlag(['--root', '/tmp/ac', 'run'])).toBe('/tmp/ac')
    expect(parseRootFlag(['--root=/tmp/ac', 'run'])).toBe('/tmp/ac')
    expect(parseRootFlag(['upgrade', '--root', '/tmp/ac'])).toBe('/tmp/ac')
  })

  it('never reads another option’s VALUE as the root', () => {
    // The daemon spawns `upgrade --to <CP-supplied version> --root <root>`. A scan
    // that inspected `--to`'s value would take the attacker's path and point every
    // filesystem write below it there.
    expect(parseRootFlag(['upgrade', '--to', '--root=/elsewhere', '--root', '/tmp/ac'])).toBe('/tmp/ac')
    expect(parseRootFlag(['upgrade', '--to', '--root', '--root', '/tmp/ac'])).toBe('/tmp/ac')
    expect(parseRootFlag(['--config', '--root=/elsewhere', '--root', '/tmp/ac'])).toBe('/tmp/ac')
    // …and with no real --root present it resolves to nothing, not the injected one.
    expect(parseRootFlag(['upgrade', '--to', '--root=/elsewhere'])).toBeUndefined()
  })

  it('stops at -- and ignores a positional that looks like the flag', () => {
    expect(parseRootFlag(['run', '--', '--root', '/elsewhere'])).toBeUndefined()
  })

  it('returns undefined when no root is given', () => {
    expect(parseRootFlag(['status'])).toBeUndefined()
    expect(parseRootFlag([])).toBeUndefined()
  })
})

describe('parseInstanceFlag', () => {
  it('reads the flag before or after the command, in both spellings', () => {
    expect(parseInstanceFlag(['--instance', 'dev', 'up'])).toBe('dev')
    expect(parseInstanceFlag(['install-service', '--instance=dev'])).toBe('dev')
    expect(parseInstanceFlag(['up'])).toBeUndefined()
  })

  it("never reads another option's value as the flag", () => {
    expect(parseInstanceFlag(['upgrade', '--to', '--instance=evil', '--instance', 'dev'])).toBe('dev')
    expect(parseInstanceFlag(['chat', '--', '--instance', 'dev'])).toBeUndefined()
  })
})

describe('withResolvedRoot', () => {
  it('translates --instance into the --root the daemon understands', () => {
    expect(withResolvedRoot(['--instance', 'dev', 'chat'], '/home/u/.agentconnect-dev')).toEqual([
      'chat',
      '--root',
      '/home/u/.agentconnect-dev'
    ])
    expect(withResolvedRoot(['run', '--instance=dev'], '/r')).toEqual(['run', '--root', '/r'])
  })

  it('leaves an explicit --root alone', () => {
    expect(withResolvedRoot(['--instance', 'dev', '--root', '/elsewhere', 'up'], '/r')).toEqual([
      '--root',
      '/elsewhere',
      'up'
    ])
  })

  it('copies other option values across untouched, including past --', () => {
    expect(
      withResolvedRoot(['--instance', 'dev', 'upgrade', '--to', '--instance', '--', '--instance', 'x'], '/r')
    ).toEqual(['upgrade', '--to', '--instance', '--', '--instance', 'x', '--root', '/r'])
  })
})

describe('classifyInvocation with instances', () => {
  it('owns `instances` and keeps routing past the --instance value', () => {
    expect(classifyInvocation(['instances'])).toBe('cli')
    expect(classifyInvocation(['--instance', 'dev', 'up'])).toBe('cli')
    expect(classifyInvocation(['--instance', 'dev', 'run'])).toBe('run')
    expect(classifyInvocation(['--instance', 'dev', 'chat'])).toBe('delegate')
  })
})
