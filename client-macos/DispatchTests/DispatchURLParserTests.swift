import XCTest
@testable import DispatchApp

final class DispatchURLParserTests: XCTestCase {

    func testValidWorkstreamURL() {
        let url = URL(string: "dispatch://workstream/frontend-refactor")!
        XCTAssertEqual(DispatchURLParser.parse(url), .openWorkstream("frontend-refactor"))
    }

    func testRejectsMissingSlug() {
        XCTAssertNil(DispatchURLParser.parse(URL(string: "dispatch://workstream/")!))
        XCTAssertNil(DispatchURLParser.parse(URL(string: "dispatch://workstream")!))
    }

    func testRejectsWrongScheme() {
        XCTAssertNil(DispatchURLParser.parse(URL(string: "http://workstream/abc")!))
        XCTAssertNil(DispatchURLParser.parse(URL(string: "manager://workstream/abc")!))
    }

    func testRejectsWrongHost() {
        XCTAssertNil(DispatchURLParser.parse(URL(string: "dispatch://decision/abc")!))
    }

    func testRejectsPathTraversal() {
        XCTAssertNil(DispatchURLParser.parse(URL(string: "dispatch://workstream/..")!))
        XCTAssertNil(DispatchURLParser.parse(URL(string: "dispatch://workstream/foo/bar")!))
    }

    func testIgnoresQueryString() {
        let url = URL(string: "dispatch://workstream/abc?ref=help")!
        XCTAssertEqual(DispatchURLParser.parse(url), .openWorkstream("abc"))
    }

    func testToleratesTrailingSlash() {
        let url = URL(string: "dispatch://workstream/abc/")!
        XCTAssertEqual(DispatchURLParser.parse(url), .openWorkstream("abc"))
    }

    func testRejectsSlugWithCaps() {
        XCTAssertNil(DispatchURLParser.parse(URL(string: "dispatch://workstream/AbC")!))
    }
}
