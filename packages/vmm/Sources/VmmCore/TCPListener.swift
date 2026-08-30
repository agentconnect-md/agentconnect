import Foundation

/// Loopback-only acceptor: a forwarded port is a hole into the guest, not a LAN service.
final class TCPListener {
    private let source: DispatchSourceRead
    /// The port actually in use, which differs from the request when it asked for 0.
    let boundPort: UInt16

    init(port: UInt16, queue: DispatchQueue, onAccept: @escaping @Sendable (Int32) -> Void) throws {
        let listenFD = socket(AF_INET, SOCK_STREAM, 0)
        guard listenFD >= 0 else { throw POSIXError.fromErrno() }

        var reuse: Int32 = 1
        setsockopt(listenFD, SOL_SOCKET, SO_REUSEADDR, &reuse, socklen_t(MemoryLayout<Int32>.size))

        var address = sockaddr_in()
        address.sin_family = sa_family_t(AF_INET)
        address.sin_port = port.bigEndian
        address.sin_addr.s_addr = INADDR_LOOPBACK.bigEndian
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)

        let bound = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(listenFD, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        guard bound == 0, listen(listenFD, 16) == 0 else {
            let error = POSIXError.fromErrno()
            close(listenFD)
            throw error
        }

        var actual = sockaddr_in()
        var length = socklen_t(MemoryLayout<sockaddr_in>.size)
        let named = withUnsafeMutablePointer(to: &actual) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                getsockname(listenFD, $0, &length)
            }
        }
        guard named == 0 else {
            let error = POSIXError.fromErrno()
            close(listenFD)
            throw error
        }
        boundPort = UInt16(bigEndian: actual.sin_port)

        source = DispatchSource.makeReadSource(fileDescriptor: listenFD, queue: queue)
        source.setEventHandler {
            let clientFD = accept(listenFD, nil, nil)
            guard clientFD >= 0 else { return }
            _ = fcntl(clientFD, F_SETFD, FD_CLOEXEC)
            onAccept(clientFD)
        }
        source.setCancelHandler { close(listenFD) }
        source.resume()
    }

    func stop() {
        source.cancel()
    }
}

extension POSIXError {
    static func fromErrno() -> POSIXError {
        POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
    }
}
