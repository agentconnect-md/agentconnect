/** The unix account a Linux system unit runs as (`User=`) — resolved from `SUDO_UID`
 *  when the CLI is elevated, since under sudo `os.homedir()`/`getuid()` describe root. */
import { execFileSync } from 'node:child_process'
import { chownSync, lstatSync, readFileSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'

export interface ServiceAccount {
  user: string
  uid: number
  gid: number
  home: string
}

/** Account names as `useradd` accepts them — also what the polkit rule interpolates. */
const ACCOUNT_NAME = /^[a-z_][a-z0-9_-]*\$?$/i

export function assertAccountName(name: string): string {
  if (name.length > 32 || !ACCOUNT_NAME.test(name)) {
    throw new Error(`invalid account name ${JSON.stringify(name)}`)
  }
  return name
}

/** Are we root? (`process.geteuid` is absent on win32.) */
export function isElevated(): boolean {
  return typeof process.geteuid === 'function' ? process.geteuid() === 0 : false
}

/** The account sudo elevated FROM. Both vars are required so a stale inherited
 *  `SUDO_USER` from an unrelated outer sudo is not mistaken for this invocation. */
export function sudoAccountName(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.SUDO_USER && env.SUDO_UID ? env.SUDO_USER : undefined
}

function parsePasswdLine(line: string): ServiceAccount | undefined {
  const [user, , uid, gid, , home] = line.split(':')
  if (!user || !uid || !gid || !home) return undefined
  return { user, uid: Number(uid), gid: Number(gid), home }
}

/** Look one account up: `/etc/passwd` first, then `getent` so LDAP/SSSD-only hosts resolve. */
export function lookupAccount(name: string): ServiceAccount | undefined {
  assertAccountName(name)
  try {
    for (const line of readFileSync('/etc/passwd', 'utf8').split('\n')) {
      if (line.startsWith(`${name}:`)) return parsePasswdLine(line)
    }
  } catch {
    // no readable /etc/passwd — fall through to getent
  }
  try {
    const out = execFileSync('getent', ['passwd', name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    return parsePasswdLine(out.split('\n')[0] ?? '')
  } catch {
    return undefined
  }
}

/** The account this process itself runs as. */
export function currentAccount(): ServiceAccount {
  const info = userInfo()
  return { user: info.username, uid: info.uid, gid: info.gid, home: info.homedir || homedir() }
}

/** Which account the service runs as: an explicit `--service-user` wins, else the
 *  account sudo came from (the normal path — install re-execs itself through sudo),
 *  else the invoking user. Real root with no sudo context and no flag is refused
 *  rather than guessed: `User=root` would hand every agent root on the host. */
export function resolveServiceAccount(opts: { serviceUser?: string } = {}): ServiceAccount {
  if (opts.serviceUser) {
    const found = lookupAccount(opts.serviceUser)
    if (!found) throw new Error(`no such account: ${opts.serviceUser}`)
    return found
  }
  if (!isElevated()) return currentAccount()
  const sudoer = sudoAccountName()
  if (sudoer) {
    const found = lookupAccount(sudoer)
    if (found) return found
  }
  throw new Error(
    'running as root with no sudo context — pass `--service-user <name>` to say which account the daemon should run as (installing it as root would give every agent root on this host)'
  )
}

/** Artifacts an elevated CLI can create under `<root>` before the daemon ever runs:
 *  the root itself (0700 via the cli-entry self-heal) and the two pointer files. */
export function rootOwnershipPaths(root: string): string[] {
  return [root, join(root, 'cli-entry'), join(root, 'service.json')]
}

export interface OwnershipDeps {
  chown?: (path: string, uid: number, gid: number) => void
  ownerOf?: (path: string) => number | undefined
}

/** Hand `<root>` back to the daemon account after an elevated install. The
 *  cli-entry self-heal runs on every invocation and creates `<root>` mode 0700 —
 *  as root that leaves the configured non-root daemon unable to read its own root.
 *  Only paths this process left root-owned are touched; returns what was repaired. */
export function repairRootOwnership(root: string, account: ServiceAccount, deps: OwnershipDeps = {}): string[] {
  if (account.uid === 0) return []
  const chown = deps.chown ?? chownSync
  const ownerOf =
    deps.ownerOf ??
    ((path: string) => {
      try {
        return lstatSync(path).uid
      } catch {
        return undefined // absent — nothing to repair
      }
    })
  const repaired: string[] = []
  for (const path of rootOwnershipPaths(root)) {
    if (ownerOf(path) !== 0) continue
    try {
      chown(path, account.uid, account.gid)
      repaired.push(path)
    } catch {
      // best-effort: a path we cannot chown is reported by its absence from the list
    }
  }
  return repaired
}
