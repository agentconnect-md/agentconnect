import Foundation

/// Builds a kernel command line where later arguments win over earlier ones with
/// the same key, so `--kernel-arg` can override anything baked into the manifest.
public struct KernelCommandLine: Equatable, Sendable {
    private var entries: [(key: String, token: String)] = []

    public init() {}

    public init(_ line: String) {
        append(contentsOf: line)
    }

    public mutating func append(contentsOf line: String) {
        for token in line.split(separator: " ", omittingEmptySubsequences: true) {
            append(String(token))
        }
    }

    public mutating func append(_ token: String) {
        let key = String(token.prefix { $0 != "=" })
        entries.removeAll { $0.key == key }
        entries.append((key, token))
    }

    public var rendered: String {
        entries.map(\.token).joined(separator: " ")
    }

    public static func == (lhs: KernelCommandLine, rhs: KernelCommandLine) -> Bool {
        lhs.rendered == rhs.rendered
    }
}
