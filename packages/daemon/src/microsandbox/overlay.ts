import { createHash } from 'node:crypto'
import type { Sandbox } from 'microsandbox'
import { z } from 'zod'
import type { SandboxMount } from '../config/config-schema.js'

export const OVERLAY_BASE_ROOT = '/opt/agentconnect-overlay-base'
export const OVERLAY_STATE_ROOT = '/var/lib/agentconnect-overlay'

export function overlayMounts(mounts: readonly SandboxMount[]) {
  return mounts
    .filter((mount) => mount.mode === 'overlay')
    .sort((a, b) => a.target.localeCompare(b.target))
    .map((mount) => ({ ...mount, key: createHash('sha256').update(mount.target).digest('hex').slice(0, 24) }))
}

const ConfigSchema = z.object({ runtime: z.object({ user: z.string().nullish() }) })

// Run once per VM boot, before any session process; only the ext4 write layer survives suspension.
const MOUNT_SCRIPT = `
import grp, json, os, pwd, subprocess, sys
config = json.loads(sys.argv[1])
user, _, group = config['user'].partition(':')
account = pwd.getpwuid(int(user)) if user.isdigit() else pwd.getpwnam(user)
uid = account.pw_uid
gid = (int(group) if group.isdigit() else grp.getgrnam(group).gr_gid) if group else account.pw_gid

def directory(path, owner=None):
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in path.strip('/').split('/'):
            if part in ('', '.', '..'):
                raise ValueError('invalid overlay directory')
            created = False
            try:
                os.mkdir(part, 0o755, dir_fd=fd)
                created = True
            except FileExistsError:
                pass
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
            if created and owner:
                os.fchown(fd, *owner)
        return fd
    except:
        os.close(fd)
        raise

state = directory(config['state'])
os.fchmod(state, 0o700)
os.close(state)
for mount in config['mounts']:
    upper = config['state'] + '/' + mount['key'] + '/upper'
    work = config['state'] + '/' + mount['key'] + '/work'
    for path in (upper, work):
        fd = directory(path)
        if path == upper:
            os.fchown(fd, uid, gid)
        os.close(fd)
    target = directory(mount['target'], (uid, gid))
    try:
        options = 'lowerdir=' + config['base'] + '/' + mount['key'] + ',upperdir=' + upper + ',workdir=' + work
        result = subprocess.run(['/usr/bin/mount', '--no-canonicalize', '-t', 'overlay', 'overlay', '-o', options, '/proc/self/fd/' + str(target)], pass_fds=(target,), capture_output=True, text=True)
        if result.returncode:
            raise RuntimeError('overlay mount failed: ' + result.stderr.strip())
    finally:
        os.close(target)
`

export async function prepareOverlayMounts(sandbox: Sandbox, mounts: readonly SandboxMount[]): Promise<void> {
  const overlays = overlayMounts(mounts)
  if (!overlays.length) return
  const { runtime } = ConfigSchema.parse(await sandbox.config())
  const config = { mounts: overlays, user: runtime.user ?? 'root', base: OVERLAY_BASE_ROOT, state: OVERLAY_STATE_ROOT }
  const result = await sandbox.execWith('/usr/bin/python3', (exec) =>
    exec
      .user('root')
      .args(['-I', '-c', MOUNT_SCRIPT, JSON.stringify(config)])
      .timeout(30_000)
  )
  if (!result.success) throw new Error(`microsandbox overlay setup failed: ${result.stderr().trim()}`)
}
