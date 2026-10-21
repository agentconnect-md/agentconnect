import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const SHA = 'a'.repeat(64)
const template = readFileSync(new URL('./install-linux.sh', import.meta.url), 'utf8')
const filled = template.replaceAll('@CP_URL@', 'https://cp.example.com').replaceAll('@BUNDLE_SHA256@', SHA)

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const exe = (path: string, body: string): void => {
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
}

// A Linux x64 desktop user with Node.js already installed; curl serves from a fixture dir and logs each URL.
function sandbox(bundleSha: string) {
  const root = mkdtempSync(join(tmpdir(), 'acd-install-'))
  dirs.push(root)
  const [bin, home, served] = ['bin', 'home', 'served'].map((name) => join(root, name)) as [string, string, string]
  for (const dir of [bin, home, served]) mkdirSync(dir)
  const script = join(root, 'install.sh')
  writeFileSync(script, filled)
  exe(join(bin, 'uname'), `[ "$1" = -m ] && echo x86_64 || echo Linux`)
  exe(join(bin, 'id'), 'echo 1000')
  exe(join(bin, 'sleep'), ':')
  exe(join(bin, 'sha256sum'), `echo "${bundleSha}  $1"`)
  exe(
    join(bin, 'curl'),
    `while [ $# -gt 1 ]; do [ "$1" = -o ] && out=$2; shift; done
echo "$1" >> "${root}/fetched"
file="${served}/$(basename "$1")"
[ -f "$file" ] || exit 22
cp "$file" "$out"`
  )
  writeFileSync(join(served, 'agentconnect-desktop.mjs'), 'bundle')
  const runtime = join(home, '.agentconnect/desktop/runtime/node-v24.12.0-linux-x64/bin')
  mkdirSync(runtime, { recursive: true })
  exe(join(runtime, 'node'), `shift; echo "$*" > "${root}/ran"`)
  const run = (...args: string[]) =>
    spawnSync('sh', [script, ...args], {
      encoding: 'utf8',
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home },
      stdio: ['ignore', 'pipe', 'pipe']
    })
  const read = (name: string): string | undefined =>
    existsSync(join(root, name)) ? readFileSync(join(root, name), 'utf8') : undefined
  return { run, read, home }
}

describe.skipIf(process.platform === 'win32')('Linux installer', () => {
  it('parses as POSIX sh once the Control Plane fills it in', () => {
    const root = mkdtempSync(join(tmpdir(), 'acd-install-'))
    dirs.push(root)
    writeFileSync(join(root, 'install.sh'), filled)
    const result = spawnSync('sh', ['-n', join(root, 'install.sh')], { encoding: 'utf8' })
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
  })

  it('prints help and refuses an unknown option or a missing value', () => {
    const box = sandbox(SHA)
    const help = box.run('--help')
    expect(help.status).toBe(0)
    expect(help.stdout).toContain('--register TOKEN')
    const unknown = box.run('--bogus')
    expect(unknown.status).not.toBe(0)
    expect(unknown.stderr).toContain('unknown option --bogus')
    expect(box.run('--register').stderr).toContain('--register needs a token')
    expect(box.read('ran')).toBeUndefined()
  })

  it('refuses to run as root', () => {
    const box = sandbox(SHA)
    exe(join(box.home, '..', 'bin', 'id'), 'echo 0')
    const result = box.run('--register', 'tok')
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('not root')
  })

  it('downloads the bundle by its sha256 and runs setup with the parsed options', () => {
    const box = sandbox(SHA)
    const result = box.run('--register', 'tok', '--name', 'my desk', '--no-service')
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    expect(box.read('fetched')).toContain(`https://cp.example.com/v1/computers/desktop/${SHA}/agentconnect-desktop.mjs`)
    expect(box.read('ran')?.trim()).toBe(
      'setup --register tok --cp-url https://cp.example.com --name my desk --no-service'
    )
    expect(existsSync(join(box.home, '.agentconnect/desktop/app/agentconnect-desktop.mjs'))).toBe(true)
  })

  it('dies on a checksum mismatch after retrying, without running or installing the bundle', () => {
    const box = sandbox('b'.repeat(64))
    const result = box.run('--register', 'tok', '--no-service')
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('rerun this command in a minute')
    expect(box.read('fetched')?.trim().split('\n')).toHaveLength(4)
    expect(box.read('ran')).toBeUndefined()
    expect(existsSync(join(box.home, '.agentconnect/desktop/app/agentconnect-desktop.mjs'))).toBe(false)
  })
})
