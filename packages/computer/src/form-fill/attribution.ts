// Which browser profile opened a loopback socket, read from /proc (computer-form-fill-and-vault.md §8): Origin alone is forgeable.
import { readdirSync, readFileSync, readlinkSync } from 'node:fs'

/** The /proc reads attribution needs; tests pass a fake tree. */
export interface ProcFs {
  read(path: string): string
  list(path: string): string[]
  link(path: string): string
}

export const realProc: ProcFs = {
  read: (path) => readFileSync(path, 'utf8'),
  list: (path) => readdirSync(path),
  link: (path) => readlinkSync(path)
}

const MAX_ANCESTORS = 16

// `0100007F:1E02` → port 7682; addresses are not compared, only that both ends are this machine's loopback.
function portOf(field: string): number {
  return Number.parseInt(field.split(':')[1] ?? '', 16)
}

function loopback(field: string): boolean {
  const address = field.split(':')[0] ?? ''
  // IPv4 127.x.y.z in little-endian hex ends in 7F; ::1 and ::ffff:127.x.y.z in tcp6.
  return (
    /^[0-9A-F]{6}7F$/i.test(address) ||
    address === '00000000000000000000000001000000' ||
    /^0000000000000000FFFF0000[0-9A-F]{6}7F$/i.test(address)
  )
}

/** The inode of the client socket whose local port is `clientPort` and whose peer is our `serverPort`. */
export function socketInode(proc: ProcFs, clientPort: number, serverPort: number): string | undefined {
  for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let text: string
    try {
      text = proc.read(table)
    } catch {
      continue
    }
    for (const line of text.split('\n').slice(1)) {
      const columns = line.trim().split(/\s+/)
      const [local, remote, inode] = [columns[1], columns[2], columns[9]]
      if (!local || !remote || !inode || inode === '0') continue
      if (portOf(local) === clientPort && portOf(remote) === serverPort && loopback(local) && loopback(remote))
        return inode
    }
  }
  return undefined
}

/** The process holding a socket inode, by scanning readable fds; another user's processes stay unreadable and are skipped. */
export function socketOwner(proc: ProcFs, inode: string, self = process.pid): number | undefined {
  const target = `socket:[${inode}]`
  for (const entry of proc.list('/proc')) {
    if (!/^\d+$/.test(entry) || Number(entry) === self) continue
    let fds: string[]
    try {
      fds = proc.list(`/proc/${entry}/fd`)
    } catch {
      continue
    }
    for (const fd of fds) {
      try {
        if (proc.link(`/proc/${entry}/fd/${fd}`) === target) return Number(entry)
      } catch {
        // Closed meanwhile.
      }
    }
  }
  return undefined
}

function parentOf(proc: ProcFs, pid: number): number | undefined {
  // The comm field may hold spaces and parentheses, so the fields after its last `)` are read.
  const stat = proc.read(`/proc/${pid}/stat`)
  const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1])
  return Number.isInteger(ppid) && ppid > 0 ? ppid : undefined
}

// The browser process itself, not a child: its binary is Chromium or Chrome and it carries no `--type=` switch.
function isBrowser(proc: ProcFs, pid: number): boolean {
  const exe = (proc.link(`/proc/${pid}/exe`).split('/').pop() ?? '').replace(/ \(deleted\)$/, '')
  // Chromium rewrites every process title, its own included, so the switches are searched in one string.
  return /^(chromium|chromium-browser|chrome)$/.test(exe) && !proc.read(`/proc/${pid}/cmdline`).includes('--type=')
}

/** The browser process at or above `pid` (the network service that owns the socket). */
export function browserAncestor(proc: ProcFs, pid: number): number | undefined {
  let current: number | undefined = pid
  for (let depth = 0; current !== undefined && depth < MAX_ANCESTORS; depth++) {
    try {
      if (isBrowser(proc, current)) return current
      current = parentOf(proc, current)
    } catch {
      return undefined
    }
  }
  return undefined
}

/** Which known profile a browser runs: the one it holds files open under (the longest, should profiles nest). */
export function openProfile(proc: ProcFs, pid: number, profiles: readonly string[]): string | undefined {
  let fds: string[]
  try {
    fds = proc.list(`/proc/${pid}/fd`)
  } catch {
    return undefined
  }
  const open = new Set<string>()
  for (const fd of fds) {
    try {
      open.add(proc.link(`/proc/${pid}/fd/${fd}`))
    } catch {
      // Closed meanwhile.
    }
  }
  const held = profiles.filter((profile) => [...open].some((path) => path.startsWith(`${profile}/`)))
  return held.sort((a, b) => b.length - a.length)[0]
}

/** The known profile whose browser opened the socket from `clientPort` to our `serverPort`, if this user can see it. */
export function attributeSocket(
  proc: ProcFs,
  clientPort: number,
  serverPort: number,
  profiles: readonly string[]
): { pid: number; profile: string } | undefined {
  const inode = socketInode(proc, clientPort, serverPort)
  const owner = inode ? socketOwner(proc, inode) : undefined
  const browser = owner === undefined ? undefined : browserAncestor(proc, owner)
  const profile = browser === undefined ? undefined : openProfile(proc, browser, profiles)
  return browser !== undefined && profile ? { pid: browser, profile } : undefined
}
