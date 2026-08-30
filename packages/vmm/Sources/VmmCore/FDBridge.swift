import Foundation

/// Copies bytes both ways between two file descriptors until either side ends.
///
/// Built on DispatchSource rather than DispatchIO: DispatchIO's read handler
/// never fires for these sockets, so nothing crossed the bridge at all.
///
/// Each direction gets its own serial queue and writes with the descriptor left
/// in blocking mode, so a slow reader applies backpressure to that direction
/// only. State changes are guarded by `state`.
final class FDBridge: @unchecked Sendable {
    private static let chunkSize = 64 << 10

    private struct Endpoint {
        let fd: Int32
        let cleanup: @Sendable () -> Void
    }

    private let leftEnd: Endpoint
    private let rightEnd: Endpoint
    private let parentQueue: DispatchQueue
    private let onFinish: @Sendable () -> Void
    private let state = NSLock()
    private var sources: [DispatchSourceRead] = []
    private var finished = false

    init(
        left: (fd: Int32, cleanup: @Sendable () -> Void),
        right: (fd: Int32, cleanup: @Sendable () -> Void),
        queue: DispatchQueue,
        onFinish: @escaping @Sendable () -> Void
    ) {
        self.leftEnd = Endpoint(fd: left.fd, cleanup: left.cleanup)
        self.rightEnd = Endpoint(fd: right.fd, cleanup: right.cleanup)
        self.parentQueue = queue
        self.onFinish = onFinish
    }

    func start() {
        let sources = [
            makeRelay(from: leftEnd, to: rightEnd),
            makeRelay(from: rightEnd, to: leftEnd),
        ]
        state.lock()
        self.sources = sources
        state.unlock()
        sources.forEach { $0.resume() }
    }

    private func makeRelay(from source: Endpoint, to destination: Endpoint) -> DispatchSourceRead {
        let queue = DispatchQueue(label: "vmm.bridge.\(source.fd)", target: parentQueue)
        let readSource = DispatchSource.makeReadSource(fileDescriptor: source.fd, queue: queue)
        readSource.setEventHandler { [weak self] in
            self?.transfer(from: source.fd, to: destination.fd)
        }
        readSource.setCancelHandler { source.cleanup() }
        return readSource
    }

    private func transfer(from source: Int32, to destination: Int32) {
        var buffer = [UInt8](repeating: 0, count: Self.chunkSize)
        let count = read(source, &buffer, Self.chunkSize)

        if count > 0 {
            if !writeAll(buffer, count: count, to: destination) { finish() }
            return
        }
        if count == 0 || (errno != EINTR && errno != EAGAIN) {
            finish()
        }
    }

    private func writeAll(_ buffer: [UInt8], count: Int, to fd: Int32) -> Bool {
        var written = 0
        while written < count {
            guard isRunning else { return false }
            let n = buffer[written...].withUnsafeBytes { bytes in
                write(fd, bytes.baseAddress, count - written)
            }
            if n > 0 {
                written += n
            } else if n < 0 && errno == EINTR {
                continue
            } else {
                return false
            }
        }
        return true
    }

    private var isRunning: Bool {
        state.lock()
        defer { state.unlock() }
        return !finished
    }

    private func finish() {
        state.lock()
        guard !finished else {
            state.unlock()
            return
        }
        finished = true
        let sources = self.sources
        state.unlock()

        sources.forEach { $0.cancel() }
        onFinish()
    }
}
