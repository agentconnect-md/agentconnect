import Foundation

public struct Manifest: Codable, Equatable, Sendable {
    public var suite: String
    public var architecture: String
    public var kernelCommandLine: String
    public var createdAt: String
    public var bridgedPorts: [UInt32]
    public var docker: Bool
    public var dockerVersion: String?

    public init(
        suite: String,
        architecture: String,
        kernelCommandLine: String,
        createdAt: String,
        bridgedPorts: [UInt32] = [22, 9515],
        docker: Bool = false,
        dockerVersion: String? = nil
    ) {
        self.suite = suite
        self.architecture = architecture
        self.kernelCommandLine = kernelCommandLine
        self.createdAt = createdAt
        self.bridgedPorts = bridgedPorts
        self.docker = docker
        self.dockerVersion = dockerVersion
    }

    /// Hand written so an image built before these fields existed still loads:
    /// those images always bridged ssh and chromedriver, and never had Docker.
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        suite = try container.decode(String.self, forKey: .suite)
        architecture = try container.decode(String.self, forKey: .architecture)
        kernelCommandLine = try container.decode(String.self, forKey: .kernelCommandLine)
        createdAt = try container.decode(String.self, forKey: .createdAt)
        bridgedPorts = try container.decodeIfPresent([UInt32].self, forKey: .bridgedPorts) ?? [22, 9515]
        docker = try container.decodeIfPresent(Bool.self, forKey: .docker) ?? false
        dockerVersion = try container.decodeIfPresent(String.self, forKey: .dockerVersion)
    }
}

extension Manifest {
    /// The guest only bridges ports with a `vsock-forward@PORT` unit enabled in the
    /// image. Forwarding any other port connects and then hangs forever, which is
    /// worth a warning rather than a mystery.
    public func unbridged(_ forwards: [PortForward]) -> [PortForward] {
        let bridged = Set(bridgedPorts)
        return forwards.filter { !bridged.contains($0.guestPort) }
    }
}

/// On-disk layout produced by `scripts/build-base-image.sh`.
public struct ImageBundle: Sendable {
    public let root: URL

    public var kernel: URL { root.appending(path: "kernel") }
    public var initrd: URL { root.appending(path: "initrd.img") }
    public var disk: URL { root.appending(path: "disk.img") }
    public var manifestFile: URL { root.appending(path: "manifest.json") }

    public init(root: URL) {
        self.root = root
    }

    public func load(using fs: FileProbing = FileManager.default) throws -> Manifest {
        guard fs.directoryExists(atPath: root.path) else {
            throw VmmError.bundleNotFound(path: root.path)
        }
        for required in [kernel, disk, manifestFile] {
            guard fs.fileExists(atPath: required.path) else {
                throw VmmError.bundleFileMissing(path: required.path)
            }
        }
        do {
            return try JSONDecoder().decode(Manifest.self, from: Data(contentsOf: manifestFile))
        } catch {
            throw VmmError.manifestUnreadable(reason: String(describing: error))
        }
    }

    public func hasInitrd(using fs: FileProbing = FileManager.default) -> Bool {
        fs.fileExists(atPath: initrd.path)
    }
}

public protocol FileProbing {
    func fileExists(atPath path: String) -> Bool
    func directoryExists(atPath path: String) -> Bool
}

extension FileManager: FileProbing {
    public func directoryExists(atPath path: String) -> Bool {
        var isDirectory: ObjCBool = false
        let exists = fileExists(atPath: path, isDirectory: &isDirectory)
        return exists && isDirectory.boolValue
    }
}
