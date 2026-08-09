import { describe, expect, it } from "vitest";
import { FORMATS } from "../../open-sse/translator/formats.js";
import {
  evaluateChatJson,
  evaluateEmbeddingJson,
  evaluateAudioResult,
  evaluateImageJson,
  evaluateVideoJson,
  createStreamingOutcomeTracker,
} from "../../open-sse/utils/upstreamOutcome.js";

describe("shared upstream outcome evaluator", () => {
  it("rejects semantic error envelopes even when HTTP was 200", () => {
    expect(evaluateChatJson({ error: { message: "quota" } }, FORMATS.OPENAI).ok).toBe(false);
    expect(evaluateEmbeddingJson({ error: { message: "quota" } }).ok).toBe(false);
  });

  it("accepts reasoning-only and tool-only chat completions", () => {
    expect(evaluateChatJson({ choices: [{ message: { reasoning_content: "thinking" }, finish_reason: "length" }] }, FORMATS.OPENAI).ok).toBe(true);
    expect(evaluateChatJson({ choices: [{ message: { tool_calls: [{ id: "c1" }] }, finish_reason: "tool_calls" }] }, FORMATS.OPENAI).ok).toBe(true);
  });

  it("accepts strict base64 embeddings and rejects empty or malformed vectors", () => {
    expect(evaluateEmbeddingJson({ data: [{ embedding: "AQID" }] }, { encodingFormat: "base64" }).ok).toBe(true);
    expect(evaluateEmbeddingJson({ data: [{ embedding: "%%%" }] }, { encodingFormat: "base64" }).ok).toBe(false);
    expect(evaluateEmbeddingJson({ data: [{ embedding: [] }] }).ok).toBe(false);
  });

  it("requires non-empty valid base64 audio", () => {
    expect(evaluateAudioResult({ base64: "AQID" }).ok).toBe(true);
    expect(evaluateAudioResult({ base64: "%%%" }).errorKind).toBe("invalid_upstream_json");
    expect(evaluateAudioResult({ base64: "" }).errorKind).toBe("empty_upstream_response");
  });

  it("requires image evidence and preserves video creation no-retry policy", () => {
    expect(evaluateImageJson({ data: [{ b64_json: "AQID" }] }).ok).toBe(true);
    expect(evaluateImageJson({ data: [{ b64_json: "%%%" }] })).toMatchObject({ ok: false, errorKind: "invalid_upstream_json" });
    expect(evaluateImageJson({ data: [] }).ok).toBe(false);
    expect(evaluateVideoJson({ status: "failed" }, { method: "POST" })).toMatchObject({ ok: false, fallbackAllowed: false });
    expect(evaluateVideoJson({ status: "failed" }, { method: "GET" })).toMatchObject({ ok: false, fallbackAllowed: true });
    expect(evaluateVideoJson({ status: "pending" }, { method: "POST" }).ok).toBe(false);
    expect(evaluateVideoJson({ status: "completed" }, { method: "GET" }).ok).toBe(false);
    expect(evaluateVideoJson({ status: "completed", video: { url: "https://example.com/v.mp4" } }, { method: "GET" }).ok).toBe(true);
  });

  it("does not turn a finish chunk into success before EOF", () => {
    const tracker = createStreamingOutcomeTracker({ format: FORMATS.OPENAI });
    tracker.observe({ data: { choices: [{ delta: { content: "x" }, finish_reason: "stop" }] } });
    expect(tracker.snapshot().state).toBe("pending");
    expect(tracker.finish().ok).toBe(true);
  });

  it("classifies failure by whether downstream was committed", () => {
    const precommit = createStreamingOutcomeTracker({ format: FORMATS.OPENAI });
    expect(precommit.fail("upstream_reset", "reset")).toMatchObject({
      state: "retryable_precommit_failure",
      fallbackAllowed: true,
    });

    const committed = createStreamingOutcomeTracker({ format: FORMATS.OPENAI });
    committed.commit();
    expect(committed.fail("upstream_reset", "reset")).toMatchObject({
      state: "committed_failure",
      fallbackAllowed: false,
    });
  });

  it("keeps client abort distinct from upstream failure", () => {
    const tracker = createStreamingOutcomeTracker({ format: FORMATS.OPENAI });
    tracker.commit();
    expect(tracker.abortClient("cancelled")).toMatchObject({
      state: "client_aborted",
      errorKind: "aborted",
      clientDisconnected: true,
      fallbackAllowed: false,
    });
  });
});
