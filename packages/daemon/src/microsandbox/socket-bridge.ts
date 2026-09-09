export const MICROSANDBOX_TUNNEL_PATHS = {
  mcp: '/tmp/agentconnect/mcp.sock',
  gitcred: '/tmp/agentconnect/gitcred.sock'
} as const
export const MICROSANDBOX_SOCKET_BRIDGES = [
  { path: MICROSANDBOX_TUNNEL_PATHS.mcp, port: 5000 },
  { path: MICROSANDBOX_TUNNEL_PATHS.gitcred, port: 5001 }
] as const

const SOCKET_BRIDGE = String.raw`
import json, os, signal, socket, stat, sys, threading

listeners = []
paths = []
connections = set()
lock = threading.Lock()
stopped = threading.Event()

def pump(source, target):
    try:
        while True:
            data = source.recv(65536)
            if not data:
                break
            target.sendall(data)
    except OSError:
        pass
    finally:
        try:
            target.shutdown(socket.SHUT_WR)
        except OSError:
            pass

def connect(client, port):
    upstream = socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM)
    with lock:
        connections.update((client, upstream))
    try:
        upstream.connect((2, port))
        reverse = threading.Thread(target=pump, args=(upstream, client), daemon=True)
        reverse.start()
        pump(client, upstream)
        reverse.join()
    except OSError:
        pass
    finally:
        with lock:
            connections.difference_update((client, upstream))
        client.close()
        upstream.close()

def accept(listener, port):
    while not stopped.is_set():
        try:
            client, _ = listener.accept()
        except OSError:
            return
        threading.Thread(target=connect, args=(client, port), daemon=True).start()

def stop(signum, frame):
    stopped.set()

signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
try:
    for bridge in json.loads(sys.argv[1]):
        path = bridge['path']
        os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
        if os.path.lexists(path):
            if not stat.S_ISSOCK(os.lstat(path).st_mode):
                raise RuntimeError('socket path is occupied: ' + path)
            os.unlink(path)
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        listener.bind(path)
        paths.append(path)
        os.chmod(path, 0o600)
        listener.listen()
        listeners.append(listener)
        threading.Thread(target=accept, args=(listener, bridge['port']), daemon=True).start()
    print('ready', flush=True)
    stopped.wait()
finally:
    for listener in listeners:
        listener.close()
    with lock:
        for connection in connections:
            connection.close()
    for path in paths:
        os.unlink(path)
`

export const MICROSANDBOX_SOCKET_BRIDGE_COMMAND = '/usr/bin/python3'
export const MICROSANDBOX_SOCKET_BRIDGE_ARGS = ['-u', '-c', SOCKET_BRIDGE, JSON.stringify(MICROSANDBOX_SOCKET_BRIDGES)]
