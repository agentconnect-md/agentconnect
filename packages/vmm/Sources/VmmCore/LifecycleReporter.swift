import Foundation

/// A lifecycle event. `booting` follows the forward binds, so it carries dialable ports; it is not readiness.
public enum VmmEvent: Encodable, Equatable, Sendable {
    case booting(BootingEvent)
    case exited(ExitedEvent)

    public struct BootingEvent: Encodable, Equatable, Sendable {
        public var event = "booting"
        public var vmmVersion: String
        public var cpuCount: Int
        public var memoryBytes: UInt64
        public var kernelCommandLine: String
        public var forwards: [Forward]
        public var dataDisk: String?
    }

    public struct ExitedEvent: Encodable, Equatable, Sendable {
        public var event = "exited"
        public var code: Int32
        public var reason: Reason
    }

    public struct Forward: Encodable, Equatable, Sendable {
        public var hostPort: UInt16
        public var guestPort: UInt32
    }

    /// Separates a guest that stopped itself from one torn down here, so a supervisor knows what is a fault.
    public enum Reason: String, Encodable, Sendable {
        case guestPoweredOff = "guest-powered-off"
        case guestError = "guest-error"
        case forced
        case startFailed = "start-failed"
    }

    public func encode(to encoder: any Encoder) throws {
        switch self {
        case .booting(let payload): try payload.encode(to: encoder)
        case .exited(let payload): try payload.encode(to: encoder)
        }
    }
}

/// ND-JSON events, off unless `--json`, so an interactive run keeps stdout for the guest console.
public struct LifecycleReporter: Sendable {
    private let sink: FileHandle?

    public init(enabled: Bool, sink: FileHandle = .standardOutput) {
        self.sink = enabled ? sink : nil
    }

    public func report(_ event: VmmEvent) {
        guard let sink else { return }
        guard var line = try? LifecycleReporter.encoder.encode(event) else { return }
        line.append(0x0A)
        try? sink.write(contentsOf: line)
    }

    static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return encoder
    }()
}
