import Foundation
import Security

public enum Entitlements {
    public static let virtualization = "com.apple.security.virtualization"

    /// Virtualization.framework rejects an unentitled process with an opaque
    /// "invalid configuration" error, so check up front and say what is wrong.
    public static func has(_ entitlement: String) -> Bool {
        guard let task = SecTaskCreateFromSelf(nil) else { return false }
        let value = SecTaskCopyValueForEntitlement(task, entitlement as CFString, nil)
        return (value as? Bool) ?? false
    }

    public static var canVirtualize: Bool { has(virtualization) }
}
