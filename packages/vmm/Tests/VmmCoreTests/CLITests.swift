import Testing
@testable import VmmCore

@Suite struct CLITests {
    @Test func defaultsToRunAgainstImageDirectory() throws {
        let invocation = try CLI.parse(arguments: [])
        #expect(invocation.subcommand == .run)
        #expect(invocation.options.bundlePath == "image")
        #expect(invocation.options.network)
        #expect(!invocation.options.rosetta)
    }

    @Test func readsPositionalBundle() throws {
        let invocation = try CLI.parse(arguments: ["run", "./builds/trixie"])
        #expect(invocation.subcommand == .run)
        #expect(invocation.options.bundlePath == "./builds/trixie")
    }

    @Test func positionalWinsOverBundleFlag() throws {
        let invocation = try CLI.parse(arguments: ["run", "positional", "--bundle", "flag"])
        #expect(invocation.options.bundlePath == "positional")
    }

    @Test func parsesFullRunInvocation() throws {
        let invocation = try CLI.parse(arguments: [
            "run", "img", "--cpus", "4", "--memory", "8GiB",
            "--forward", "9515:9515", "--forward", "2222:22",
            "--share", "out=./artifacts", "--share", "src=/repo:ro",
            "--kernel-arg", "loglevel=7", "--rosetta", "--no-network",
        ])
        let options = invocation.options
        #expect(options.cpuCount == 4)
        #expect(options.memoryBytes == 8 << 30)
        #expect(options.forwards == [
            PortForward(hostPort: 9515, guestPort: 9515),
            PortForward(hostPort: 2222, guestPort: 22),
        ])
        #expect(options.shares == [
            DirectoryShare(tag: "out", path: "./artifacts", readOnly: false),
            DirectoryShare(tag: "src", path: "/repo", readOnly: true),
        ])
        #expect(options.extraKernelArgs == ["loglevel=7"])
        #expect(options.rosetta)
        #expect(!options.network)
    }

    @Test func parsesSupervisedRunFlags() throws {
        let invocation = try CLI.parse(arguments: [
            "run", "img", "--data-disk", "/var/agent.img",
            "--console-log", "/var/console.log", "--json",
        ])
        let options = invocation.options
        #expect(options.dataDiskPath == "/var/agent.img")
        #expect(options.consoleLogPath == "/var/console.log")
        #expect(options.jsonEvents)
    }

    @Test func supervisedFlagsDefaultOff() throws {
        let options = try CLI.parse(arguments: ["run"]).options
        #expect(options.dataDiskPath == nil)
        #expect(options.consoleLogPath == nil)
        #expect(!options.jsonEvents)
    }

    @Test func acceptsDynamicHostPort() throws {
        let options = try CLI.parse(arguments: ["run", "--forward", "0:8085"]).options
        #expect(options.forwards == [PortForward(hostPort: 0, guestPort: 8085)])
        #expect(options.forwards[0].isDynamic)
        #expect(!PortForward(hostPort: 2222, guestPort: 22).isDynamic)
    }

    @Test func stillRejectsAGuestPortOfZero() throws {
        #expect(throws: VmmError.invalidForward("2222:0")) { try PortForward.parse("2222:0") }
    }

    @Test func recognisesSubcommands() throws {
        #expect(try CLI.parse(arguments: ["info"]).subcommand == .info)
        #expect(try CLI.parse(arguments: ["help"]).subcommand == .help)
        #expect(try CLI.parse(arguments: ["--help"]).subcommand == .help)
        #expect(try CLI.parse(arguments: ["-h"]).subcommand == .help)
        #expect(try CLI.parse(arguments: ["--version"]).subcommand == .version)
    }

    @Test func rejectsBadInput() {
        #expect(throws: VmmError.unknownSubcommand("boot")) { try CLI.parse(arguments: ["boot"]) }
        #expect(throws: VmmError.unknownOption("--turbo")) { try CLI.parse(arguments: ["--turbo"]) }
        #expect(throws: VmmError.missingValue("--cpus")) { try CLI.parse(arguments: ["--cpus"]) }
        #expect(throws: VmmError.invalidNumber(option: "--cpus", value: "0")) {
            try CLI.parse(arguments: ["--cpus", "0"])
        }
        #expect(throws: VmmError.invalidNumber(option: "--cpus", value: "many")) {
            try CLI.parse(arguments: ["--cpus", "many"])
        }
        #expect(throws: VmmError.unknownOption("second")) {
            try CLI.parse(arguments: ["run", "first", "second"])
        }
    }
}

@Suite struct PortForwardTests {
    @Test func parsesPair() throws {
        #expect(try PortForward.parse("9515:9515") == PortForward(hostPort: 9515, guestPort: 9515))
        #expect(try PortForward.parse("18080:80") == PortForward(hostPort: 18080, guestPort: 80))
    }

    @Test func readsHostPortZeroAsAnEphemeralRequest() throws {
        #expect(try PortForward.parse("0:9515") == PortForward(hostPort: 0, guestPort: 9515))
    }

    @Test(arguments: ["9515", "9515:", ":9515", "9515:0", "70000:22", "a:b", "1:2:3", ""])
    func rejectsMalformed(input: String) {
        #expect(throws: VmmError.invalidForward(input)) { try PortForward.parse(input) }
    }
}

@Suite struct DirectoryShareTests {
    @Test func parsesTagAndPath() throws {
        #expect(try DirectoryShare.parse("out=./a") == DirectoryShare(tag: "out", path: "./a"))
        #expect(try DirectoryShare.parse("src=/repo:ro") == DirectoryShare(tag: "src", path: "/repo", readOnly: true))
    }

    @Test(arguments: ["out", "=./a", "out=", "out=:ro", "a/b=/tmp"])
    func rejectsMalformed(input: String) {
        #expect(throws: VmmError.invalidShare(input)) { try DirectoryShare.parse(input) }
    }
}
