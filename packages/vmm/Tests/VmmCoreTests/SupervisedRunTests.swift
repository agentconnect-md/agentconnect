import Foundation
import Testing
@testable import VmmCore

@Suite struct TCPListenerTests {
    @Test func reportsTheEphemeralPortItWasGiven() throws {
        let queue = DispatchQueue(label: "test.listener")
        let listener = try TCPListener(port: 0, queue: queue) { close($0) }
        defer { listener.stop() }
        #expect(listener.boundPort != 0)
    }

    @Test func givesConcurrentListenersDistinctPorts() throws {
        let queue = DispatchQueue(label: "test.listener.distinct")
        let first = try TCPListener(port: 0, queue: queue) { close($0) }
        defer { first.stop() }
        let second = try TCPListener(port: 0, queue: queue) { close($0) }
        defer { second.stop() }
        #expect(first.boundPort != second.boundPort)
    }

    /// Proves a non-zero request binds that exact port rather than drifting to an
    /// ephemeral one: asking again for a port still held has to fail. Testing it the
    /// other way round would need a guaranteed-free port, which does not exist.
    @Test func honoursANonZeroPortLiterally() throws {
        let queue = DispatchQueue(label: "test.listener.literal")
        let holder = try TCPListener(port: 0, queue: queue) { close($0) }
        defer { holder.stop() }
        #expect(throws: (any Error).self) {
            try TCPListener(port: holder.boundPort, queue: queue) { close($0) }
        }
    }
}

@Suite struct LifecycleReporterTests {
    /// Reads back what a reporter wrote, since the daemon parses these lines and a
    /// silently reshaped field would only surface as a launch that never binds.
    static func emitted(_ events: [VmmEvent]) throws -> [[String: Any]] {
        let path = URL(filePath: NSTemporaryDirectory())
            .appending(path: "vmm-events-\(UUID().uuidString).ndjson")
        FileManager.default.createFile(atPath: path.path, contents: nil)
        defer { try? FileManager.default.removeItem(at: path) }
        guard let handle = FileHandle(forWritingAtPath: path.path) else { return [] }
        let reporter = LifecycleReporter(enabled: true, sink: handle)
        events.forEach { reporter.report($0) }
        try handle.close()
        return try String(contentsOf: path, encoding: .utf8)
            .split(separator: "\n", omittingEmptySubsequences: true)
            .map { try JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any] ?? [:] }
    }

    static let booting = VmmEvent.booting(
        VmmEvent.BootingEvent(
            vmmVersion: "1.0.0",
            cpuCount: 2,
            memoryBytes: 2 << 30,
            kernelCommandLine: "console=hvc0 root=/dev/vda rw",
            forwards: [VmmEvent.Forward(hostPort: 52344, guestPort: 8085)],
            dataDisk: "/var/agent.img"
        )
    )

    @Test func emitsOneJsonObjectPerLine() throws {
        let lines = try Self.emitted([Self.booting, .exited(VmmEvent.ExitedEvent(code: 0, reason: .guestPoweredOff))])
        #expect(lines.count == 2)
        #expect(lines[0]["event"] as? String == "booting")
        #expect(lines[1]["event"] as? String == "exited")
    }

    @Test func bootingCarriesThePortsASupervisorMustDial() throws {
        let lines = try Self.emitted([Self.booting])
        let forwards = lines[0]["forwards"] as? [[String: Any]]
        #expect(forwards?.count == 1)
        #expect(forwards?[0]["hostPort"] as? Int == 52344)
        #expect(forwards?[0]["guestPort"] as? Int == 8085)
        #expect(lines[0]["dataDisk"] as? String == "/var/agent.img")
        #expect(lines[0]["vmmVersion"] as? String == "1.0.0")
    }

    @Test func exitReasonsAreDistinguishable() throws {
        let reasons: [VmmEvent.Reason] = [.guestPoweredOff, .guestError, .forced, .startFailed]
        let lines = try Self.emitted(reasons.map { .exited(VmmEvent.ExitedEvent(code: 1, reason: $0)) })
        #expect(lines.compactMap { $0["reason"] as? String }
            == ["guest-powered-off", "guest-error", "forced", "start-failed"])
    }

    /// Off by default: an interactive run gives stdout to the guest console, and a
    /// stray JSON line in that stream would corrupt the console log.
    @Test func writesNothingWhenDisabled() throws {
        let path = URL(filePath: NSTemporaryDirectory())
            .appending(path: "vmm-events-\(UUID().uuidString).ndjson")
        FileManager.default.createFile(atPath: path.path, contents: nil)
        defer { try? FileManager.default.removeItem(at: path) }
        let handle = FileHandle(forWritingAtPath: path.path)!
        LifecycleReporter(enabled: false, sink: handle).report(Self.booting)
        try handle.close()
        #expect(try Data(contentsOf: path).isEmpty)
    }
}

@Suite struct DetachedConsoleTests {
    @Test func createsTheLogAndItsParentDirectory() throws {
        let root = URL(filePath: NSTemporaryDirectory())
            .appending(path: "vmm-console-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let log = root.appending(path: "nested/console.log")
        let console = try SerialConsole.detached(logPath: log.path)
        #expect(FileManager.default.fileExists(atPath: log.path))
        // A regular file is not a tty, so raw mode must be a no-op rather than an error.
        console.enterRawMode()
        console.restore()
        _ = console.configuration
    }

    @Test func appendsRatherThanTruncatingAcrossBoots() throws {
        let root = URL(filePath: NSTemporaryDirectory())
            .appending(path: "vmm-console-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let log = root.appending(path: "console.log")
        _ = try SerialConsole.detached(logPath: log.path)
        try "first boot\n".write(to: log, atomically: false, encoding: .utf8)
        _ = try SerialConsole.detached(logPath: log.path)
        #expect(try String(contentsOf: log, encoding: .utf8).contains("first boot"))
    }
}
