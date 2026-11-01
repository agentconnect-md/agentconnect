import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Wayland hides the screen from X11 grabbers; capture goes through the xdg-desktop-portal ScreenCast + PipeWire instead.
export const waylandSession = (): boolean => process.platform === 'linux' && Boolean(process.env.WAYLAND_DISPLAY)

// Python (gi) holds the portal session, which lives only as long as its D-Bus connection, and runs GStreamer to emit Y4M.
const HELPER = String.raw`#!/usr/bin/env python3
# Usage: screencast.py TOKEN_FILE FPS CURSOR(1|0) [FRAMES]. Asks the ScreenCast portal for the monitor (persisting a restore
# token so consent is asked once), then streams it as Y4M on stdout until killed.
import os, signal, subprocess, sys
import gi
gi.require_version('Gio', '2.0')
from gi.repository import Gio, GLib

token_path, fps = sys.argv[1], int(sys.argv[2])
show_cursor = sys.argv[3] == '1'
frames = int(sys.argv[4]) if len(sys.argv) > 4 else 0
NAME, PATH = 'org.freedesktop.portal.Desktop', '/org/freedesktop/portal/desktop'
IFACE = 'org.freedesktop.portal.ScreenCast'
bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
sender = bus.get_unique_name()[1:].replace('.', '_')
loop = GLib.MainLoop()
seq = [0]

def fail(message):
    sys.stderr.write('screencast: %s\n' % message)
    sys.exit(2)

def request(method, build):
    seq[0] += 1
    token = 'acd%d_%d' % (os.getpid(), seq[0])
    path = '%s/request/%s/%s' % (PATH, sender, token)
    result = {}
    def on_response(_conn, _sender, _path, _iface, _signal, params):
        result['code'], result['results'] = params.unpack()
        loop.quit()
    sub = bus.signal_subscribe(NAME, 'org.freedesktop.portal.Request', 'Response', path, None,
                               Gio.DBusSignalFlags.NONE, on_response)
    bus.call_sync(NAME, PATH, IFACE, method, build(GLib.Variant('s', token)), None, Gio.DBusCallFlags.NONE, -1, None)
    loop.run()
    bus.signal_unsubscribe(sub)
    if result.get('code') != 0:
        fail('%s was denied or cancelled (portal response %s)' % (method, result.get('code')))
    return result['results']

modes = bus.call_sync(NAME, PATH, 'org.freedesktop.DBus.Properties', 'Get',
                      GLib.Variant('(ss)', (IFACE, 'AvailableCursorModes')), None, Gio.DBusCallFlags.NONE, -1,
                      None).unpack()[0]
# 2 embeds the pointer in the frames, 1 hides it.
cursor = 2 if show_cursor and modes & 2 else 1
session = request('CreateSession', lambda t: GLib.Variant('(a{sv})', (
    {'handle_token': t, 'session_handle_token': GLib.Variant('s', 'acd%d' % os.getpid())},)))['session_handle']
options = {'types': GLib.Variant('u', 1), 'multiple': GLib.Variant('b', False),
           'cursor_mode': GLib.Variant('u', cursor), 'persist_mode': GLib.Variant('u', 2)}
try:
    with open(token_path) as f:
        options['restore_token'] = GLib.Variant('s', f.read().strip())
except OSError:
    pass
request('SelectSources', lambda t: GLib.Variant('(oa{sv})', (session, dict(options, handle_token=t))))
started = request('Start', lambda t: GLib.Variant('(osa{sv})', (session, '', {'handle_token': t})))
if started.get('restore_token'):
    with open(token_path, 'w') as f:
        f.write(started['restore_token'])
streams = started.get('streams') or []
if not streams:
    fail('the portal returned no stream')
node = streams[0][0]
reply, fds = bus.call_with_unix_fd_list_sync(NAME, PATH, IFACE, 'OpenPipeWireRemote',
                                             GLib.Variant('(oa{sv})', (session, {})), GLib.VariantType('(h)'),
                                             Gio.DBusCallFlags.NONE, -1, None, None)
fd = fds.get(reply.unpack()[0])
source = ['pipewiresrc', 'fd=%d' % fd, 'path=%d' % node, 'do-timestamp=true', 'keepalive-time=500']
if frames:
    source.append('num-buffers=%d' % frames)
pipeline = source + ['!', 'videorate', '!', 'video/x-raw,framerate=%d/1' % fps, '!', 'videoconvert', '!',
                     'video/x-raw,format=I420', '!', 'y4menc', '!', 'fdsink', 'fd=1']
child = subprocess.Popen(['gst-launch-1.0', '-q'] + pipeline, pass_fds=(fd,))
signal.signal(signal.SIGTERM, lambda *_: child.terminate())
sys.exit(child.wait())
`

export function writeCaptureHelper(dataDir: string): string {
  mkdirSync(dataDir, { recursive: true })
  const path = join(dataDir, 'screencast.py')
  writeFileSync(path, HELPER, { mode: 0o755 })
  return path
}

export const screencastTokenPath = (dataDir: string): string => join(dataDir, 'screencast.token')
