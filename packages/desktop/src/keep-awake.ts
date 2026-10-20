import { spawn, spawnSync, type ChildProcess } from 'node:child_process'

// A sleeping display has nothing to capture (macOS even drops its capture devices), so the daemon holds it awake.
export function keepDisplayAwake(log: (line: string) => void): () => void {
  let child: ChildProcess | undefined
  if (process.platform === 'darwin') {
    // -d/-i hold the display on until this process (-w) exits.
    wakeDisplay()
    child = spawn('caffeinate', ['-d', '-i', '-w', String(process.pid)], { stdio: 'ignore' })
  } else if (process.platform === 'win32') {
    // ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED, held by this helper until the daemon exits.
    const script = `$t = Add-Type -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);' -Name Power -Namespace AgentConnect -PassThru
[void]$t::SetThreadExecutionState([uint32]2147483651)
Wait-Process -Id ${process.pid}`
    child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      stdio: 'ignore',
      windowsHide: true
    })
  } else if (process.platform === 'linux' && gnomeSession() && hasCommand('gnome-session-inhibit')) {
    // GNOME blanks and locks on idle; the inhibitor lasts while its command (tail waiting on our pid) runs.
    child = spawn(
      'gnome-session-inhibit',
      [
        '--inhibit',
        'idle',
        '--reason',
        'AgentConnect Desktop is serving this screen',
        'tail',
        `--pid=${process.pid}`,
        '-f',
        '/dev/null'
      ],
      { stdio: 'ignore' }
    )
  } else if (process.platform === 'linux' && x11Session() && hasCommand('xset')) {
    // Other X11 desktops: switch the X screensaver and DPMS off for this display (left off on exit).
    spawnSync('xset', ['s', 'off', 's', 'noblank', '-dpms'], { stdio: 'ignore' })
    log('X screensaver and DPMS disabled on this display')
    return () => undefined
  } else {
    return () => undefined
  }
  child.once('error', (error) => log(`keep-awake helper failed: ${error.message}`))
  log('keeping the display awake while the daemon runs')
  return () => child?.kill()
}

// Declares user activity, which turns a sleeping macOS display back on (capture fails while it is off).
export function wakeDisplay(): void {
  if (process.platform === 'darwin') spawnSync('caffeinate', ['-u', '-t', '1'], { stdio: 'ignore' })
}

export const hasCommand = (command: string): boolean =>
  spawnSync('sh', ['-c', `command -v ${command}`], { stdio: 'ignore' }).status === 0

const gnomeSession = (): boolean => /GNOME/i.test(process.env.XDG_CURRENT_DESKTOP ?? '')
const x11Session = (): boolean => Boolean(process.env.DISPLAY) && !process.env.WAYLAND_DISPLAY

// Whether keepDisplayAwake can do anything on this machine.
export const canKeepAwake = (): boolean =>
  process.platform === 'darwin' ||
  process.platform === 'win32' ||
  (gnomeSession() && hasCommand('gnome-session-inhibit')) ||
  (x11Session() && hasCommand('xset'))

// The OS display-sleep timeout in minutes (0 = never), where it can be read without privileges.
export function displaySleepMinutes(): number | undefined {
  if (process.platform !== 'darwin') return undefined
  const result = spawnSync('pmset', ['-g'], { encoding: 'utf8' })
  const match = /^\s*displaysleep\s+(\d+)/m.exec(result.stdout ?? '')
  return match ? Number(match[1]) : undefined
}
