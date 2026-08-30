import Testing
@testable import VmmCore

@Suite struct KernelCommandLineTests {
    @Test func preservesOrderAndSpacing() {
        let line = KernelCommandLine("console=hvc0  root=/dev/vda rw")
        #expect(line.rendered == "console=hvc0 root=/dev/vda rw")
    }

    @Test func laterArgumentOverridesSameKey() {
        var line = KernelCommandLine("console=hvc0 loglevel=3 root=/dev/vda")
        line.append("loglevel=7")
        #expect(line.rendered == "console=hvc0 root=/dev/vda loglevel=7")
    }

    @Test func overridesValuelessFlag() {
        var line = KernelCommandLine("root=/dev/vda ro quiet")
        line.append("ro")
        #expect(line.rendered == "root=/dev/vda quiet ro")
    }

    @Test func emptyLineRendersEmpty() {
        #expect(KernelCommandLine("").rendered == "")
    }
}
