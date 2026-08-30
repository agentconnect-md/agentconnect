import Foundation
import Virtualization

/// Wires the guest's virtio console to this process' stdin/stdout.
public final class SerialConsole {
    private var savedAttributes: termios?
    private let input: FileHandle
    private let output: FileHandle

    public init(input: FileHandle = .standardInput, output: FileHandle = .standardOutput) {
        self.input = input
        self.output = output
    }

    /// Supervised run: console to a file, stdin never read, and raw mode self-skips on a non-tty.
    public static func detached(logPath: String) throws -> SerialConsole {
        let url = URL(filePath: logPath).absoluteURL
        let fs = FileManager.default
        try fs.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        if !fs.fileExists(atPath: url.path) {
            fs.createFile(atPath: url.path, contents: nil)
        }
        guard let output = FileHandle(forWritingAtPath: url.path) else {
            throw VmmError.consoleLogUnwritable(path: url.path)
        }
        output.seekToEndOfFile()
        guard let input = FileHandle(forReadingAtPath: "/dev/null") else {
            throw VmmError.consoleLogUnwritable(path: "/dev/null")
        }
        return SerialConsole(input: input, output: output)
    }

    public var configuration: VZSerialPortConfiguration {
        let port = VZVirtioConsoleDeviceSerialPortConfiguration()
        port.attachment = VZFileHandleSerialPortAttachment(
            fileHandleForReading: input,
            fileHandleForWriting: output
        )
        return port
    }

    /// ISIG stays on so ctrl-c reaches this process: an unresponsive guest must stay escapable.
    public func enterRawMode() {
        guard isatty(input.fileDescriptor) == 1 else { return }
        var attributes = termios()
        guard tcgetattr(input.fileDescriptor, &attributes) == 0 else { return }
        savedAttributes = attributes
        attributes.c_iflag &= ~tcflag_t(ICRNL)
        attributes.c_lflag &= ~tcflag_t(ICANON | ECHO)
        tcsetattr(input.fileDescriptor, TCSANOW, &attributes)
    }

    public func restore() {
        guard var attributes = savedAttributes else { return }
        tcsetattr(input.fileDescriptor, TCSANOW, &attributes)
        savedAttributes = nil
    }
}
