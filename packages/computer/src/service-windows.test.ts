import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { launchScript, migrateUserData, withoutClixml } from './service-windows.js'

const dirs: string[] = []
const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'service-windows-'))
  dirs.push(dir)
  return dir
}
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })))

describe('Windows service', () => {
  it('moves the per-user setup into the service data dir once, and never over the service copy', () => {
    const from = temp()
    const home = join(temp(), 'computer')
    writeFileSync(join(from, 'config.json'), '{"port":7681}')
    writeFileSync(join(from, 'computer-key.json'), '{}')
    writeFileSync(join(from, 'daemon.log'), 'not moved')
    const lines: string[] = []
    migrateUserData(from, home, (line) => lines.push(line))
    expect(readFileSync(join(home, 'config.json'), 'utf8')).toBe('{"port":7681}')
    expect(readFileSync(join(home, 'computer-key.json'), 'utf8')).toBe('{}')
    expect(() => readFileSync(join(home, 'daemon.log'))).toThrow()
    expect(lines).toHaveLength(1)

    writeFileSync(join(from, 'config.json'), '{"port":1}')
    migrateUserData(from, home, (line) => lines.push(line))
    expect(readFileSync(join(home, 'config.json'), 'utf8')).toBe('{"port":7681}')
    expect(lines).toHaveLength(1)
  })

  it('passes the app name to PowerShell as one quoted literal', () => {
    const script = launchScript("O'Brien & co; $(calc)")
    expect(script).toContain("$app = 'O''Brien & co; $(calc)'")
    expect(script).toContain('Get-StartApps')
  })

  it('reads the error out of PowerShell CLIXML on stderr', () => {
    const stderr =
      '#< CLIXML\r\nno app or Start menu entry named x\r\n<Objs Version="1.1.0.1"><Obj S="progress"></Obj></Objs>'
    expect(withoutClixml(stderr)).toBe('no app or Start menu entry named x')
    expect(withoutClixml('plain failure\n')).toBe('plain failure')
  })
})
