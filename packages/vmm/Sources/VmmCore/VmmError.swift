import Foundation

public enum VmmError: Error, CustomStringConvertible, Equatable {
    case invalidSize(String)
    case unknownSubcommand(String)
    case unknownOption(String)
    case missingValue(String)
    case invalidNumber(option: String, value: String)
    case invalidForward(String)
    case invalidShare(String)
    case bundleNotFound(path: String)
    case bundleFileMissing(path: String)
    case manifestUnreadable(reason: String)
    case dataDiskMissing(path: String)
    case consoleLogUnwritable(path: String)
    case rosettaUnavailable(String)
    case configurationInvalid(String)
    case notEntitled

    public var description: String {
        switch self {
        case .invalidSize(let text):
            return "not a valid size: '\(text)' (try 4GiB, 512M, 2048)"
        case .unknownSubcommand(let name):
            return "unknown command '\(name)'"
        case .unknownOption(let name):
            return "unknown option '\(name)'"
        case .missingValue(let name):
            return "option '\(name)' requires a value"
        case .invalidNumber(let option, let value):
            return "option '\(option)' expects a positive integer, got '\(value)'"
        case .invalidForward(let text):
            return "not a valid forward: '\(text)' (expected HOSTPORT:GUESTPORT, e.g. 9515:9515)"
        case .invalidShare(let text):
            return "not a valid share: '\(text)' (expected TAG=PATH, e.g. work=./artifacts)"
        case .bundleNotFound(let path):
            return "image bundle not found at \(path) (build one with scripts/build-base-image.sh)"
        case .bundleFileMissing(let path):
            return "image bundle is incomplete, missing \(path)"
        case .manifestUnreadable(let reason):
            return "manifest.json could not be read: \(reason)"
        case .dataDiskMissing(let path):
            return "data disk not found at \(path)"
        case .consoleLogUnwritable(let path):
            return "console log could not be opened for writing at \(path)"
        case .rosettaUnavailable(let reason):
            return "Rosetta for Linux is not usable: \(reason)"
        case .configurationInvalid(let reason):
            return "virtual machine configuration rejected: \(reason)"
        case .notEntitled:
            return """
            this binary is not signed with '\(Entitlements.virtualization)'.
            Virtualization.framework refuses to run without it. Sign it with:
              make sign
            or manually: codesign --sign - --entitlements vmm.entitlements --force <binary>
            """
        }
    }
}
