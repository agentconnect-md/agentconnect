import { describe, expect, it } from 'vitest'
import { computerCommandLine, narrowerFiles, narrowerShell } from './computer-command-line.js'
import { ComputerChannelTokenClaims } from './computer-channel-token.js'
import { computerAuditArgs } from './frames/computer-audit.js'
import { ComputerPolicySchema } from './frames/computer.js'

describe('the command-line tier (computer-use.md §5.7)', () => {
  it('is off on a self-hosted Computer and on for a managed one unless the policy says otherwise', () => {
    const policy = ComputerPolicySchema.parse({})
    expect(computerCommandLine(policy, { kind: 'self-hosted' })).toEqual({ shell: 'off', files: 'off' })
    expect(computerCommandLine(policy, { kind: 'managed' })).toEqual({ shell: 'on', files: 'read-write' })
    const set = ComputerPolicySchema.parse({ shell: 'ask', files: 'read' })
    expect(computerCommandLine(set, { kind: 'managed' })).toEqual({ shell: 'ask', files: 'read' })
  })

  it('offers no shell on a view Computer, and refuses a policy that would set one', () => {
    const view = ComputerPolicySchema.parse({ agentMode: 'view', files: 'read' })
    expect(computerCommandLine(view, { kind: 'managed' })).toEqual({ shell: 'off', files: 'read' })
    expect(ComputerPolicySchema.safeParse({ agentMode: 'view', shell: 'on' }).success).toBe(false)
    expect(ComputerPolicySchema.safeParse({ agentMode: 'view', shell: 'off' }).success).toBe(true)
  })

  it('takes only absolute file roots', () => {
    expect(ComputerPolicySchema.safeParse({ fileRoots: ['/srv/data', '~/work', '~', 'C:\\Users'] }).success).toBe(true)
    expect(ComputerPolicySchema.safeParse({ fileRoots: ['work'] }).success).toBe(false)
    expect(ComputerPolicySchema.safeParse({ fileRoots: ['~other/x'] }).success).toBe(false)
  })

  it('narrows to what both a token and a later policy allow', () => {
    expect(narrowerShell('on', 'ask')).toBe('ask')
    expect(narrowerShell('ask', 'on')).toBe('ask')
    expect(narrowerShell('on', 'off')).toBe('off')
    expect(narrowerFiles('read-write', 'read')).toBe('read')
    expect(narrowerFiles('off', 'read-write')).toBe('off')
  })

  it('keeps the tier claims in a channel token, and an older token without them still parses', () => {
    const base = { aud: 'mcp', cmp: '00000000-0000-4000-8000-000000000001', kid: 'k', iat: 1, exp: 2 }
    const mcp = { ...base, ses: 's', agt: '00000000-0000-4000-8000-000000000002', mode: 'control' }
    expect(ComputerChannelTokenClaims.parse({ ...mcp, sh: 'ask', fs: 'read' })).toMatchObject({ sh: 'ask', fs: 'read' })
    expect(ComputerChannelTokenClaims.parse(mcp)).not.toHaveProperty('sh')
  })

  it('audits a command in full up to its cap, and written content by length only', () => {
    const command = `echo ${'x'.repeat(2000)}`
    const audited = computerAuditArgs({ command, cwd: '/tmp' })
    expect((audited.args.command as string).length).toBe(1536)
    expect(audited.args.cwd).toBe('/tmp')
    expect(computerAuditArgs({ path: '/tmp/a', content: 'secret text' })).toEqual({
      args: { path: '/tmp/a' },
      textLength: 11
    })
  })
})
