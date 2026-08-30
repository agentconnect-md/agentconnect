import Testing
@testable import VmmCore

@Suite struct ByteCountTests {
    @Test(arguments: [
        ("4GiB", UInt64(4) << 30),
        ("4G", UInt64(4) << 30),
        ("512M", UInt64(512) << 20),
        ("512MiB", UInt64(512) << 20),
        ("2048", 2048),
        ("2048b", 2048),
        ("1kb", 1000),
        ("1KiB", 1024),
        ("  8gib  ", UInt64(8) << 30),
    ])
    func parsesSizes(input: String, expected: UInt64) throws {
        #expect(try ByteCount.parse(input) == expected)
    }

    @Test(arguments: ["", "  ", "GiB", "-1G", "0", "0MiB", "4.5G", "4Gib5", "abc"])
    func rejectsGarbage(input: String) {
        #expect(throws: VmmError.invalidSize(input)) { try ByteCount.parse(input) }
    }

    @Test func rejectsOverflow() {
        #expect(throws: VmmError.self) { try ByteCount.parse("99999999999999999999TiB") }
    }

    @Test(arguments: [
        (UInt64(4) << 30, "4GiB"),
        (UInt64(512) << 20, "512MiB"),
        (UInt64(1536) << 20, "1.5GiB"),
        (UInt64(2048), "2KiB"),
        (UInt64(512), "512B"),
    ])
    func describesSizes(bytes: UInt64, expected: String) {
        #expect(ByteCount.describe(bytes) == expected)
    }
}
