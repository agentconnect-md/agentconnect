import Foundation
import Virtualization

/// The framework's NAT has no port forwarding, so host access goes over vsock to a guest socat unit.
@MainActor
public final class PortForwarder {
    private let device: VZVirtioSocketDevice
    private let queue = DispatchQueue(label: "vmm.forwarder", attributes: .concurrent)
    private var listeners: [TCPListener] = []
    private var active: [UUID: FDBridge] = [:]

    public init(device: VZVirtioSocketDevice) {
        self.device = device
    }

    /// Returns the forward as bound, so a `hostPort: 0` request comes back with a dialable port.
    @discardableResult
    public func start(_ forward: PortForward) throws -> PortForward {
        let listener = try TCPListener(port: forward.hostPort, queue: queue) { [weak self] clientFD in
            Task { @MainActor in
                guard let self else {
                    close(clientFD)
                    return
                }
                await self.bridge(clientFD: clientFD, to: forward.guestPort)
            }
        }
        listeners.append(listener)
        return PortForward(hostPort: listener.boundPort, guestPort: forward.guestPort)
    }

    /// VZVirtioSocketConnection is not Sendable, but after the handoff it is only the bridge queue's.
    private final class ConnectionBox: @unchecked Sendable {
        let connection: VZVirtioSocketConnection
        init(_ connection: VZVirtioSocketConnection) { self.connection = connection }
        func close() { connection.close() }
    }

    private func bridge(clientFD: Int32, to guestPort: UInt32) async {
        let connection: VZVirtioSocketConnection
        do {
            connection = try await device.connect(toPort: guestPort)
        } catch {
            FileHandle.standardError.write(
                Data("vmm: vsock port \(guestPort) refused: \(error.localizedDescription)\n".utf8)
            )
            close(clientFD)
            return
        }

        let identity = UUID()
        let box = ConnectionBox(connection)
        let bridge = FDBridge(
            left: (clientFD, { close(clientFD) }),
            right: (box.connection.fileDescriptor, { box.close() }),
            queue: queue,
            onFinish: { [weak self] in
                Task { @MainActor in self?.active[identity] = nil }
            }
        )
        active[identity] = bridge
        bridge.start()
    }

    public func stop() {
        listeners.forEach { $0.stop() }
        listeners.removeAll()
        active.removeAll()
    }
}
