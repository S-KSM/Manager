import XCTest
@testable import DispatchApp

/// v1.4.14 — covers the regex used by `LLMErrorView` to detect a
/// "model not found" failure mode and offer the inline Pull button.
/// Specifically what the daemon returns from `/reports/generate` when the
/// local LLM (ollama / mlx_lm.server) returns a 4xx for an unknown model.
final class LLMErrorViewTests: XCTestCase {

    func testExtractsModelNameFromOllamaSingleQuotes() {
        let msg = #"Local LLM HTTP 404: {"error":{"message":"model 'qwen3:8b' not found"}}"#
        XCTAssertEqual(LLMErrorView.extractMissingModelName(from: msg), "qwen3:8b")
    }

    func testExtractsModelNameFromDoubleQuotes() {
        let msg = #"Local LLM HTTP 404: {"error":"model "llama3.2:3b" not found"}"#
        XCTAssertEqual(LLMErrorView.extractMissingModelName(from: msg), "llama3.2:3b")
    }

    func testExtractsModelNameFromBackticks() {
        let msg = "Local LLM HTTP 404: model `qwen2.5-coder:14b` not found"
        XCTAssertEqual(LLMErrorView.extractMissingModelName(from: msg), "qwen2.5-coder:14b")
    }

    func testIsCaseInsensitiveOnLiteral() {
        let msg = "model 'qwen3:8b' Not Found"
        XCTAssertEqual(LLMErrorView.extractMissingModelName(from: msg), "qwen3:8b")
    }

    func testHandlesPathLikeNames() {
        // HuggingFace-style names with slashes should round-trip.
        let msg = "model 'hf.co/bartowski/qwen3-8b-gguf' not found"
        XCTAssertEqual(LLMErrorView.extractMissingModelName(from: msg), "hf.co/bartowski/qwen3-8b-gguf")
    }

    func testReturnsNilForUnrelatedError() {
        XCTAssertNil(LLMErrorView.extractMissingModelName(from: "Could not generate: 500 internal server error"))
        XCTAssertNil(LLMErrorView.extractMissingModelName(from: "Daemon unreachable"))
        XCTAssertNil(LLMErrorView.extractMissingModelName(from: ""))
    }

    func testReturnsNilWhenNameWouldContainShellMetacharacters() {
        // Defense-in-depth: extracted name is fed into a Pull request that
        // shells `ollama pull <name>` daemon-side. The model-name pattern
        // refuses anything outside [A-Za-z0-9._:/-], so a quoted shell-injection
        // attempt should not match.
        let msg = "model 'qwen3:8b; rm -rf /' not found"
        XCTAssertNil(LLMErrorView.extractMissingModelName(from: msg))
    }

    func testLastNonEmptyLineOfMultilineOutput() {
        XCTAssertEqual(LLMErrorView.lastNonEmptyLine("pulling manifest\n\nsuccess\n"), "success")
        XCTAssertEqual(LLMErrorView.lastNonEmptyLine(""), nil)
        XCTAssertEqual(LLMErrorView.lastNonEmptyLine("   \n  \n"), nil)
    }
}
