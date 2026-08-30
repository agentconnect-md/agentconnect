import Foundation

public enum ByteCount {
    static let multipliers: [(suffix: String, factor: UInt64)] = [
        ("kib", 1 << 10), ("mib", 1 << 20), ("gib", 1 << 30), ("tib", 1 << 40),
        ("kb", 1000), ("mb", 1000 * 1000), ("gb", 1000 * 1000 * 1000), ("tb", 1000 * 1000 * 1000 * 1000),
        ("k", 1 << 10), ("m", 1 << 20), ("g", 1 << 30), ("t", 1 << 40),
        ("b", 1),
    ]

    public static func parse(_ text: String) throws -> UInt64 {
        let normalized = text.trimmingCharacters(in: .whitespaces).lowercased()
        guard !normalized.isEmpty else { throw VmmError.invalidSize(text) }

        let match = multipliers.first { normalized.hasSuffix($0.suffix) }
        let digits = normalized.dropLast(match?.suffix.count ?? 0)
        guard let value = UInt64(digits), value > 0 else { throw VmmError.invalidSize(text) }

        let factor = match?.factor ?? 1
        let (product, overflow) = value.multipliedReportingOverflow(by: factor)
        guard !overflow else { throw VmmError.invalidSize(text) }
        return product
    }

    public static func describe(_ bytes: UInt64) -> String {
        let units: [(String, UInt64)] = [("GiB", 1 << 30), ("MiB", 1 << 20), ("KiB", 1 << 10)]
        for (name, factor) in units where bytes >= factor {
            let whole = Double(bytes) / Double(factor)
            return String(format: whole == whole.rounded() ? "%.0f%@" : "%.1f%@", whole, name)
        }
        return "\(bytes)B"
    }
}
