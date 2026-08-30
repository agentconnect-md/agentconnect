import Foundation

public struct PortForward: Equatable, Sendable {
    public let hostPort: UInt16
    public let guestPort: UInt32

    public init(hostPort: UInt16, guestPort: UInt32) {
        self.hostPort = hostPort
        self.guestPort = guestPort
    }

    /// `hostPort == 0` asks for an ephemeral port, since many VMs cannot share one fixed one.
    public var isDynamic: Bool { hostPort == 0 }

    public static func parse(_ text: String) throws -> PortForward {
        let parts = text.split(separator: ":", omittingEmptySubsequences: false)
        guard parts.count == 2,
              let host = UInt16(parts[0]),
              let guest = UInt32(parts[1]), guest > 0
        else { throw VmmError.invalidForward(text) }
        return PortForward(hostPort: host, guestPort: guest)
    }
}

public struct DirectoryShare: Equatable, Sendable {
    public let tag: String
    public let path: String
    public let readOnly: Bool

    public init(tag: String, path: String, readOnly: Bool = false) {
        self.tag = tag
        self.path = path
        self.readOnly = readOnly
    }

    public static func parse(_ text: String) throws -> DirectoryShare {
        guard let separator = text.firstIndex(of: "="), separator != text.startIndex else {
            throw VmmError.invalidShare(text)
        }
        let tag = String(text[text.startIndex..<separator])
        var path = String(text[text.index(after: separator)...])
        var readOnly = false
        if path.hasSuffix(":ro") {
            readOnly = true
            path.removeLast(3)
        }
        guard !path.isEmpty, !tag.contains("/") else { throw VmmError.invalidShare(text) }
        return DirectoryShare(tag: tag, path: path, readOnly: readOnly)
    }
}

public enum Subcommand: String, Sendable {
    case run
    case info
    case help
    case version
}

public struct RunOptions: Equatable, Sendable {
    public var bundlePath: String = "image"
    public var cpuCount: Int?
    public var memoryBytes: UInt64?
    public var forwards: [PortForward] = []
    public var shares: [DirectoryShare] = []
    public var rosetta = false
    public var extraKernelArgs: [String] = []
    public var network = true
    /// Persistent per-agent disk attached as `/dev/vdb`; the rootfs stays disposable.
    public var dataDiskPath: String?
    /// Guest console to a file, which is what frees this process' stdout for lifecycle events.
    public var consoleLogPath: String?
    /// Emit ND-JSON lifecycle events on stdout for a supervising process.
    public var jsonEvents = false
}

public struct Invocation: Equatable, Sendable {
    public var subcommand: Subcommand
    public var options: RunOptions
}

public enum CLI {
    public static func parse(arguments: [String]) throws -> Invocation {
        var arguments = arguments
        var options = RunOptions()
        var subcommand = Subcommand.run

        if let first = arguments.first, !first.hasPrefix("-") {
            guard let parsed = Subcommand(rawValue: first) else {
                throw VmmError.unknownSubcommand(first)
            }
            subcommand = parsed
            arguments.removeFirst()
        }

        var index = 0
        var positionalBundle: String?

        func nextValue(for option: String) throws -> String {
            index += 1
            guard index < arguments.count else { throw VmmError.missingValue(option) }
            return arguments[index]
        }

        while index < arguments.count {
            let argument = arguments[index]
            switch argument {
            case "--bundle":
                options.bundlePath = try nextValue(for: argument)
            case "--cpus":
                let raw = try nextValue(for: argument)
                guard let count = Int(raw), count > 0 else {
                    throw VmmError.invalidNumber(option: argument, value: raw)
                }
                options.cpuCount = count
            case "--memory":
                options.memoryBytes = try ByteCount.parse(try nextValue(for: argument))
            case "--forward":
                options.forwards.append(try PortForward.parse(try nextValue(for: argument)))
            case "--share":
                options.shares.append(try DirectoryShare.parse(try nextValue(for: argument)))
            case "--kernel-arg":
                options.extraKernelArgs.append(try nextValue(for: argument))
            case "--data-disk":
                options.dataDiskPath = try nextValue(for: argument)
            case "--console-log":
                options.consoleLogPath = try nextValue(for: argument)
            case "--json":
                options.jsonEvents = true
            case "--rosetta":
                options.rosetta = true
            case "--no-network":
                options.network = false
            case "-h", "--help":
                subcommand = .help
            case "--version":
                subcommand = .version
            default:
                guard !argument.hasPrefix("-") else { throw VmmError.unknownOption(argument) }
                guard positionalBundle == nil else { throw VmmError.unknownOption(argument) }
                positionalBundle = argument
            }
            index += 1
        }

        if let positionalBundle {
            options.bundlePath = positionalBundle
        }
        return Invocation(subcommand: subcommand, options: options)
    }

    public static let usage = """
    agentconnect-vmm - boot a Linux VM with Virtualization.framework

    USAGE
      agentconnect-vmm run [BUNDLE] [options]   boot the image bundle (default: ./image)
      agentconnect-vmm info [BUNDLE]            print the bundle manifest
      agentconnect-vmm help | agentconnect-vmm --version

    OPTIONS
      --bundle PATH        image bundle directory
      --cpus N             virtual CPUs (default: half the host cores, min 2)
      --memory SIZE        guest memory, e.g. 4GiB, 2048M (default: 4GiB)
      --forward H:G        forward host TCP port H to guest vsock port G (repeatable);
                           H=0 picks an ephemeral port, reported in the JSON events
      --share TAG=PATH     expose a host directory over virtiofs, :ro for read only
      --kernel-arg ARG     append or override a kernel command line argument
      --data-disk PATH     attach a persistent disk image as /dev/vdb
      --console-log PATH   write the guest console to PATH instead of this terminal
      --json               emit ND-JSON lifecycle events on stdout
      --rosetta            attach Rosetta for Linux (cft-rosetta images only)
      --no-network         boot without a NAT network device

    EXAMPLES
      agentconnect-vmm run image --forward 9515:9515 --share out=./artifacts
      agentconnect-vmm run image --cpus 4 --memory 8GiB --kernel-arg loglevel=7
    """
}
