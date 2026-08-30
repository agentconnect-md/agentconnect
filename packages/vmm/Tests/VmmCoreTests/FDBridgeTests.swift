import Foundation
import Testing
@testable import VmmCore

private func makeSocketPair() -> (Int32, Int32) {
    var fds: [Int32] = [0, 0]
    #expect(socketpair(AF_UNIX, SOCK_STREAM, 0, &fds) == 0)
    return (fds[0], fds[1])
}

private func write(_ text: String, to fd: Int32) {
    let bytes = Array(text.utf8)
    #expect(Foundation.write(fd, bytes, bytes.count) == bytes.count)
}

private func read(_ count: Int, from fd: Int32, timeout: TimeInterval = 5) -> String {
    var buffer = [UInt8](repeating: 0, count: count)
    var received = 0
    let deadline = Date().addingTimeInterval(timeout)
    while received < count, Date() < deadline {
        var poller = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
        guard poll(&poller, 1, 200) > 0 else { continue }
        let n = buffer[received...].withUnsafeMutableBytes {
            Foundation.read(fd, $0.baseAddress, $0.count)
        }
        if n <= 0 { break }
        received += n
    }
    return String(decoding: buffer[..<received], as: UTF8.self)
}

@Suite(.serialized) struct FDBridgeTests {
    @Test func relaysBothDirections() async throws {
        let (leftInner, leftOuter) = makeSocketPair()
        let (rightInner, rightOuter) = makeSocketPair()
        let queue = DispatchQueue(label: "test.bridge", attributes: .concurrent)

        let bridge = FDBridge(
            left: (leftInner, { close(leftInner) }),
            right: (rightInner, { close(rightInner) }),
            queue: queue,
            onFinish: {}
        )
        bridge.start()

        write("ping-from-left", to: leftOuter)
        #expect(read(14, from: rightOuter) == "ping-from-left")

        write("pong-from-right", to: rightOuter)
        #expect(read(15, from: leftOuter) == "pong-from-right")

        close(leftOuter)
        close(rightOuter)
    }

    @Test func relaysDataArrivingInSeveralChunks() async throws {
        let (leftInner, leftOuter) = makeSocketPair()
        let (rightInner, rightOuter) = makeSocketPair()
        let queue = DispatchQueue(label: "test.bridge.chunks", attributes: .concurrent)

        let bridge = FDBridge(
            left: (leftInner, { close(leftInner) }),
            right: (rightInner, { close(rightInner) }),
            queue: queue,
            onFinish: {}
        )
        bridge.start()

        for index in 0..<5 {
            write("chunk\(index);", to: leftOuter)
        }
        #expect(read(35, from: rightOuter) == "chunk0;chunk1;chunk2;chunk3;chunk4;")

        close(leftOuter)
        close(rightOuter)
    }

    @Test func reportsCompletionWhenOneSideCloses() async throws {
        let (leftInner, leftOuter) = makeSocketPair()
        let (rightInner, rightOuter) = makeSocketPair()
        let queue = DispatchQueue(label: "test.bridge.close", attributes: .concurrent)
        let finished = Finished()

        let bridge = FDBridge(
            left: (leftInner, { close(leftInner) }),
            right: (rightInner, { close(rightInner) }),
            queue: queue,
            onFinish: { finished.signal() }
        )
        bridge.start()

        close(leftOuter)
        #expect(await finished.wait(seconds: 5))
        close(rightOuter)
    }
}

private final class Finished: @unchecked Sendable {
    private let semaphore = DispatchSemaphore(value: 0)
    func signal() { semaphore.signal() }
    func wait(seconds: Int) async -> Bool {
        await withCheckedContinuation { continuation in
            DispatchQueue.global().async {
                continuation.resume(returning: self.semaphore.wait(timeout: .now() + .seconds(seconds)) == .success)
            }
        }
    }
}
