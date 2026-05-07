import XCTest
@testable import DispatchApp

final class DaemonResolverTests: XCTestCase {

    func testDispatchDaemonMockReturnsMock() {
        let env = ["DISPATCH_DAEMON": "mock"]
        XCTAssertEqual(DaemonResolver.pickModeFromEnv(env), .mock)
    }

    func testDispatchDaemonLiveReturnsLive() {
        let env = ["DISPATCH_DAEMON": "live"]
        XCTAssertEqual(DaemonResolver.pickModeFromEnv(env), .live)
    }

    func testManagerDaemonIsIgnored() {
        // v1.3 removed the legacy MANAGER_* env-var fallback. A bare
        // MANAGER_DAEMON=mock must NOT pin the resolver to mock.
        let env = ["MANAGER_DAEMON": "mock"]
        XCTAssertNil(DaemonResolver.pickModeFromEnv(env))
    }

    func testEmptyEnvReturnsNil() {
        XCTAssertNil(DaemonResolver.pickModeFromEnv([:]))
    }

    func testUnknownValueReturnsNil() {
        XCTAssertNil(DaemonResolver.pickModeFromEnv(["DISPATCH_DAEMON": "garbage"]))
    }
}
