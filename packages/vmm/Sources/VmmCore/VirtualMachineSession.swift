import Foundation
import Virtualization

@MainActor
public final class VirtualMachineSession: NSObject, @MainActor VZVirtualMachineDelegate {
    private let spec: VirtualMachineSpec
    private let forwards: [PortForward]
    private let console: SerialConsole
    private let reporter: LifecycleReporter
    private var machine: VZVirtualMachine?
    private var forwarder: PortForwarder?
    private var signalSources: [DispatchSourceSignal] = []
    private var exit: CheckedContinuation<Int32, Never>?
    private var stopping = false
    private var bound: [PortForward] = []
    private var reportedExit = false

    public init(
        spec: VirtualMachineSpec,
        forwards: [PortForward],
        console: SerialConsole = SerialConsole(),
        reporter: LifecycleReporter = LifecycleReporter(enabled: false)
    ) {
        self.spec = spec
        self.forwards = forwards
        self.console = console
        self.reporter = reporter
        super.init()
    }

    public func run() async throws -> Int32 {
        let configuration = try VirtualMachineFactory.makeConfiguration(spec, console: console.configuration)
        let machine = VZVirtualMachine(configuration: configuration)
        machine.delegate = self
        self.machine = machine

        report()
        installSignalHandlers()
        console.enterRawMode()
        defer { console.restore() }

        do {
            try await machine.start()
        } catch {
            reportExit(code: 1, reason: .startFailed)
            throw VmmError.configurationInvalid(error.localizedDescription)
        }

        startForwarding(on: machine)
        // After the binds, so a dynamic `hostPort: 0` reports the port a supervisor must dial.
        reporter.report(
            .booting(
                VmmEvent.BootingEvent(
                    vmmVersion: VmmVersion.current,
                    cpuCount: spec.cpuCount,
                    memoryBytes: spec.memoryBytes,
                    kernelCommandLine: spec.kernelCommandLine,
                    forwards: bound.map { VmmEvent.Forward(hostPort: $0.hostPort, guestPort: $0.guestPort) },
                    dataDisk: spec.dataDiskPath
                )
            )
        )

        let code = await withCheckedContinuation { (continuation: CheckedContinuation<Int32, Never>) in
            exit = continuation
        }
        forwarder?.stop()
        return code
    }

    private func startForwarding(on machine: VZVirtualMachine) {
        guard !forwards.isEmpty else { return }
        guard let device = machine.socketDevices.first as? VZVirtioSocketDevice else { return }
        let forwarder = PortForwarder(device: device)
        for forward in forwards {
            do {
                let resolved = try forwarder.start(forward)
                bound.append(resolved)
                if forward.isDynamic {
                    warn("forward 127.0.0.1:\(resolved.hostPort) -> vsock:\(resolved.guestPort) (ephemeral)")
                }
            } catch {
                warn("cannot listen on 127.0.0.1:\(forward.hostPort): \(error.localizedDescription)")
            }
        }
        self.forwarder = forwarder
    }

    private func report() {
        warn("booting \(spec.manifest.suite)/\(spec.manifest.architecture)")
        warn("  \(spec.cpuCount) cpu, \(ByteCount.describe(spec.memoryBytes)) memory, cmdline: \(spec.kernelCommandLine)")
        if let dockerVersion = spec.manifest.dockerVersion {
            warn("  docker \(dockerVersion) with compose v2")
        }
        for forward in forwards where !forward.isDynamic {
            warn("  forward 127.0.0.1:\(forward.hostPort) -> vsock:\(forward.guestPort)")
        }
        if let dataDisk = spec.dataDiskPath {
            warn("  data disk \(dataDisk) -> /dev/vdb")
        }
        for forward in spec.manifest.unbridged(forwards) {
            warn("  warning: the image bridges no vsock port \(forward.guestPort); enable vsock-forward@\(forward.guestPort) in the guest or it will hang")
        }
        for share in spec.shares {
            warn("  share \(share.tag) -> \(share.path)\(share.readOnly ? " (ro)" : "")")
        }
        warn("  ctrl-c requests a clean shutdown, ctrl-c twice forces it")
    }

    private func installSignalHandlers() {
        for number in [SIGINT, SIGTERM] {
            signal(number, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
            source.setEventHandler { [weak self] in
                Task { @MainActor in self?.handleInterrupt() }
            }
            source.resume()
            signalSources.append(source)
        }
    }

    private func handleInterrupt() {
        guard let machine else { return }
        guard !stopping else {
            warn("forcing power off")
            Task { @MainActor in
                try? await machine.stop()
                self.reportExit(code: 1, reason: .forced)
                self.finish(code: 1)
            }
            return
        }
        stopping = true
        warn("requesting guest shutdown")
        do {
            try machine.requestStop()
        } catch {
            warn("guest refused the shutdown request: \(error.localizedDescription)")
            Task { @MainActor in
                try? await machine.stop()
                self.reportExit(code: 1, reason: .forced)
                self.finish(code: 1)
            }
        }
    }

    private func reportExit(code: Int32, reason: VmmEvent.Reason) {
        guard !reportedExit else { return }
        reportedExit = true
        reporter.report(.exited(VmmEvent.ExitedEvent(code: code, reason: reason)))
    }

    private func finish(code: Int32) {
        guard let continuation = exit else { return }
        exit = nil
        signalSources.forEach { $0.cancel() }
        continuation.resume(returning: code)
    }

    private func warn(_ message: String) {
        FileHandle.standardError.write(Data("vmm: \(message)\n".utf8))
    }

    public func guestDidStop(_ virtualMachine: VZVirtualMachine) {
        console.restore()
        warn("guest powered off")
        reportExit(code: 0, reason: .guestPoweredOff)
        finish(code: 0)
    }

    public func virtualMachine(_ virtualMachine: VZVirtualMachine, didStopWithError error: any Error) {
        console.restore()
        warn("guest stopped with error: \(error.localizedDescription)")
        reportExit(code: 1, reason: .guestError)
        finish(code: 1)
    }

    public func virtualMachine(
        _ virtualMachine: VZVirtualMachine,
        networkDevice: VZNetworkDevice,
        attachmentWasDisconnectedWithError error: any Error
    ) {
        warn("network detached: \(error.localizedDescription)")
    }
}
