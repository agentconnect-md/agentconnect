import { describe, expect, it } from 'vitest'
import { attributeSocket, browserAncestor, openProfile, socketInode, type ProcFs } from './attribution.js'

const HEADER = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode'
const row = (local: string, remote: string, inode: string) =>
  `   0: ${local} ${remote} 01 00000000:00000000 00:00000000 00000000  1000        0 ${inode} 1 0000000000000000 20 4 30 10 -1`
// 127.0.0.1:41000 → 127.0.0.1:7682 (0xA028 = 41000, 0x1E02 = 7682), and the server's own side.
const TCP = [HEADER, row('0100007F:A028', '0100007F:1E02', '5551'), row('0100007F:1E02', '0100007F:A028', '5552')].join(
  '\n'
)

const MAIN = '/home/agent/.config/chromium'
const D1 = '/home/agent/.agentconnect/computer/desktops/d1/browser'

interface Process {
  exe: string
  // Chromium rewrites every process title into one space-joined string.
  title: string
  ppid: number
  fds: Record<string, string>
}

function fakeProc(processes: Record<number, Process>): ProcFs {
  const pid = (path: string) => Number(/^\/proc\/(\d+)\//.exec(path)?.[1])
  const fail = (path: string): never => {
    throw Object.assign(new Error(`ENOENT ${path}`), { code: 'ENOENT' })
  }
  return {
    read: (path) => {
      if (path === '/proc/net/tcp') return TCP
      if (path === '/proc/net/tcp6') return HEADER
      const process = processes[pid(path)]
      if (process && path.endsWith('/cmdline')) return `${process.title}\0`
      if (process && path.endsWith('/stat')) return `${pid(path)} (some (odd) name) S ${process.ppid} 1 1 0`
      return fail(path)
    },
    list: (path) => {
      if (path === '/proc') return [...Object.keys(processes), 'self', 'net']
      const process = processes[pid(path)]
      return process && path.endsWith('/fd') ? Object.keys(process.fds) : fail(path)
    },
    link: (path) => {
      const process = processes[pid(path)]
      if (process && path.endsWith('/exe')) return process.exe
      const fd = /\/fd\/(\d+)$/.exec(path)?.[1]
      return (process && fd && process.fds[fd]) || fail(path)
    }
  }
}

// A desktop browser (pid 100) on `profile`, and its network service child (pid 140) holding the socket.
const desktop = (profile: string, exe = '/usr/lib/chromium/chromium') =>
  fakeProc({
    1: { exe: '/usr/bin/tini', title: '/usr/bin/tini', ppid: 0, fds: {} },
    100: {
      exe,
      title: `${exe} --no-sandbox --user-data-dir=${profile} --ozone-platform=x11`,
      ppid: 1,
      fds: { '3': 'pipe:[1]', '40': `${profile}/Default/History`, '41': `${profile}/Local State` }
    },
    140: {
      exe,
      title: `${exe} --type=utility --utility-sub-type=network.mojom.NetworkService`,
      ppid: 100,
      fds: { '7': 'socket:[999]', '9': 'socket:[5551]', '12': `${profile}/Default/Cookies` }
    }
  })

describe('form fill socket attribution (computer-form-fill-and-vault.md §8)', () => {
  it('finds the client end of a loopback connection to the endpoint', () => {
    expect(socketInode(desktop(MAIN), 41000, 7682)).toBe('5551')
    expect(socketInode(desktop(MAIN), 41001, 7682)).toBeUndefined()
  })

  it('walks from the network service to the browser and picks the known profile it holds open', () => {
    expect(attributeSocket(desktop(D1), 41000, 7682, [MAIN, D1])).toEqual({ pid: 100, profile: D1 })
    expect(attributeSocket(desktop(MAIN), 41000, 7682, [MAIN, D1])).toEqual({ pid: 100, profile: MAIN })
    const chrome = desktop('/home/agent/.config/google-chrome', '/opt/google/chrome/chrome')
    expect(attributeSocket(chrome, 41000, 7682, [MAIN, D1])).toBeUndefined()
  })

  it('takes the longest profile when profiles nest', () => {
    const nested = `${MAIN}/nested`
    expect(openProfile(desktop(nested), 100, [MAIN, nested])).toBe(nested)
  })

  it('refuses a socket whose owner is not under a browser, whatever its title claims', () => {
    const forged = fakeProc({
      1: { exe: '/usr/bin/tini', title: '/usr/bin/tini', ppid: 0, fds: {} },
      300: {
        exe: '/usr/bin/python3',
        title: `/usr/lib/chromium/chromium --user-data-dir=${MAIN}`,
        ppid: 1,
        fds: { '4': 'socket:[5551]', '5': `${MAIN}/Default/Cookies` }
      }
    })
    expect(attributeSocket(forged, 41000, 7682, [MAIN])).toBeUndefined()
  })

  it('does not take a child process for the browser', () => {
    const orphan = fakeProc({
      1: { exe: '/usr/bin/tini', title: '/usr/bin/tini', ppid: 0, fds: {} },
      140: {
        exe: '/usr/lib/chromium/chromium',
        title: '/usr/lib/chromium/chromium --type=renderer',
        ppid: 1,
        fds: {}
      }
    })
    expect(browserAncestor(orphan, 140)).toBeUndefined()
  })
})
