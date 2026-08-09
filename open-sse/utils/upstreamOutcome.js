import { Buffer } from "node:buffer";
import { FORMATS } from "../translator/formats.js";

export const OUTCOME_STATE = Object.freeze({
  PENDING: "pending",
  OK: "ok",
  PRECOMMIT_FAILURE: "retryable_precommit_failure",
  COMMITTED_FAILURE: "committed_failure",
  CLIENT_ABORTED: "client_aborted",
});

const RESPONSES_SUCCESS = new Set(["response.completed", "response.done"]);
const RESPONSES_FAILURE = new Set(["response.failed", "response.incomplete", "error"]);

function asMessage(value, fallback = "Upstream returned an error payload") {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (!value || typeof value !== "object") return fallback;
  const nested = value.message || value.detail;
  if (typeof nested === "string" && nested.trim()) return nested.trim();
  if (nested && typeof nested === "object") return asMessage(nested, fallback);
  return value.code || value.type || fallback;
}

export function extractPayloadError(payload) {
  if (!payload || typeof payload !== "object") return null;

  if (payload.error) {
    return {
      message: asMessage(payload.error),
      errorKind: payload.errorKind || payload.error?.errorKind || "upstream_payload_error",
      payload: payload.error,
    };
  }

  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    return {
      message: asMessage(payload.errors[0]),
      errorKind: "upstream_payload_error",
      payload: payload.errors,
    };
  }

  const nested = payload.response;
  if (nested && typeof nested === "object" && nested.error) {
    return {
      message: asMessage(nested.error),
      errorKind: "upstream_payload_error",
      payload: nested.error,
    };
  }

  return null;
}

function hasOpenAIChatEvidence(payload) {
  const choice = payload?.choices?.[0];
  const message = choice?.message || choice?.delta;
  if (!message) return false;
  if (typeof message.content === "string" && message.content.length > 0) return true;
  if (typeof message.reasoning_content === "string" && message.reasoning_content.length > 0) return true;
  if (typeof message.reasoning === "string" && message.reasoning.length > 0) return true;
  return Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
}

function hasClaudeEvidence(payload) {
  if (!Array.isArray(payload?.content)) return false;
  return payload.content.some((block) =>
    (block?.type === "text" && typeof block.text === "string" && block.text.length > 0)
    || (block?.type === "thinking" && typeof block.thinking === "string" && block.thinking.length > 0)
    || block?.type === "tool_use"
  );
}

function responsesItems(payload) {
  return payload?.output || payload?.response?.output || [];
}

function hasResponsesEvidence(payload) {
  if (!Array.isArray(responsesItems(payload))) return false;
  return responsesItems(payload).some((item) => {
    if (!item || typeof item !== "object") return false;
    if (["function_call", "custom_tool_call", "image_generation_call", "computer_call"].includes(item.type)) return true;
    if (item.type === "reasoning") {
      return (item.summary || item.content || []).some((part) => typeof part?.text === "string" && part.text.length > 0);
    }
    return (item.content || []).some((part) =>
      typeof part?.text === "string" && part.text.length > 0
      || typeof part?.image_url === "string" && part.image_url.length > 0
    );
  });
}

function geminiCandidates(payload) {
  return payload?.response?.candidates || payload?.candidates || [];
}

function hasGeminiEvidence(payload) {
  return geminiCandidates(payload).some((candidate) =>
    (candidate?.content?.parts || []).some((part) =>
      typeof part?.text === "string" && part.text.length > 0
      || !!part?.functionCall
      || !!part?.function_call
      || !!part?.inlineData?.data
      || !!part?.inline_data?.data
    )
  );
}

export function evaluateChatJson(payload, format) {
  const error = extractPayloadError(payload);
  if (error) return { ok: false, ...error };
  if (!payload || typeof payload !== "object") {
    return { ok: false, errorKind: "empty_upstream_response", message: "Upstream returned an empty response" };
  }

  if (format === FORMATS.OPENAI_RESPONSES || payload.object === "response") {
    const status = payload.status || payload.response?.status;
    if (status === "failed") {
      return { ok: false, errorKind: "upstream_payload_error", message: asMessage(payload.error || payload.response?.error, "Upstream response failed") };
    }
    if (status === "incomplete" || status === "in_progress") {
      return { ok: false, errorKind: "upstream_incomplete", message: `Upstream response ended with status ${status}` };
    }
    if (status === "completed" || status === "done" || hasResponsesEvidence(payload)) return { ok: true };
    return { ok: false, errorKind: "upstream_incomplete", message: "Upstream response ended without a completed response" };
  }

  if (format === FORMATS.CLAUDE || payload.type === "message") {
    if (payload.stop_reason || hasClaudeEvidence(payload)) return { ok: true };
    return { ok: false, errorKind: "upstream_incomplete", message: "Claude response ended without output or stop_reason" };
  }

  if ([FORMATS.GEMINI, FORMATS.GEMINI_CLI, FORMATS.VERTEX, FORMATS.ANTIGRAVITY].includes(format)
      || Array.isArray(payload.candidates) || Array.isArray(payload.response?.candidates)) {
    const candidates = geminiCandidates(payload);
    if (hasGeminiEvidence(payload) || candidates.some((candidate) => !!candidate?.finishReason)) return { ok: true };
    return { ok: false, errorKind: "upstream_incomplete", message: "Gemini response ended without output or finishReason" };
  }

  if (format === FORMATS.OLLAMA || payload.done !== undefined) {
    if (payload.done === true || typeof payload.response === "string" || payload.message) return { ok: true };
    return { ok: false, errorKind: "upstream_incomplete", message: "Ollama response ended before done=true" };
  }

  if (Array.isArray(payload.choices)) {
    const choice = payload.choices[0];
    if (choice?.finish_reason != null || hasOpenAIChatEvidence(payload)) return { ok: true };
    return { ok: false, errorKind: "upstream_incomplete", message: "Chat response ended without output or finish_reason" };
  }

  // Unknown provider-specific bodies remain compatible unless they carry an error.
  return { ok: true };
}

export function decodeBase64(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || normalized.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) return null;
  const unpadded = normalized.replace(/=+$/, "");
  try {
    const decoded = Buffer.from(normalized, "base64");
    if (decoded.length === 0 || decoded.toString("base64").replace(/=+$/, "") !== unpadded) return null;
    return decoded;
  } catch {
    return null;
  }
}

function validEmbedding(value, encodingFormat) {
  if (encodingFormat === "base64") return decodeBase64(value) !== null;
  return Array.isArray(value) && value.length > 0 && value.every((item) => Number.isFinite(item));
}

export function evaluateEmbeddingJson(payload, { allowEmpty = false, encodingFormat = "float" } = {}) {
  const error = extractPayloadError(payload);
  if (error) return { ok: false, ...error };

  const vectors = [];
  if (Array.isArray(payload?.data)) {
    for (const item of payload.data) vectors.push(item?.embedding);
  } else if (Array.isArray(payload?.embeddings)) {
    for (const item of payload.embeddings) vectors.push(Array.isArray(item) ? item : item?.values);
  } else if (payload?.embedding) {
    vectors.push(Array.isArray(payload.embedding) ? payload.embedding : payload.embedding.values);
  }

  if (vectors.length === 0 && allowEmpty) return { ok: true };
  if (vectors.length > 0 && vectors.every((vector) => validEmbedding(vector, encodingFormat))) return { ok: true };
  return { ok: false, errorKind: "invalid_upstream_json", message: "Upstream returned no valid embedding vectors" };
}

export function evaluateAudioResult(result) {
  if (result?.success === false) return { ok: false, errorKind: result.errorKind || "upstream_payload_error", message: result.error || "TTS request failed" };
  if (typeof result?.base64 !== "string" || result.base64.length === 0) {
    return { ok: false, errorKind: "empty_upstream_response", message: "Upstream returned no audio" };
  }
  if (!decodeBase64(result.base64)) {
    return { ok: false, errorKind: "invalid_upstream_json", message: "Upstream returned invalid audio data" };
  }
  return { ok: true };
}

export function evaluateImageJson(payload) {
  const error = extractPayloadError(payload);
  if (error) return { ok: false, ...error };
  const items = payload?.data;
  if (!Array.isArray(items) || items.length === 0) {
    return { ok: false, errorKind: "empty_upstream_response", message: "Upstream returned no image" };
  }

  const valid = items.some((item) =>
    decodeBase64(item?.b64_json) !== null
    || typeof item?.url === "string" && item.url.trim().length > 0
  );
  if (valid) return { ok: true };

  const hasMalformedBase64 = items.some((item) => typeof item?.b64_json === "string");
  return {
    ok: false,
    errorKind: hasMalformedBase64 ? "invalid_upstream_json" : "empty_upstream_response",
    message: hasMalformedBase64 ? "Upstream returned invalid image data" : "Upstream returned no image",
  };
}

export function evaluateVideoJson(payload, { method = "GET" } = {}) {
  const error = extractPayloadError(payload);
  const status = String(payload?.status || "").toLowerCase();
  if (error || ["failed", "error", "cancelled", "canceled"].includes(status)) {
    return {
      ok: false,
      errorKind: error?.errorKind || "upstream_payload_error",
      message: error?.message || asMessage(payload?.error, `Video job ${status || "failed"}`),
      fallbackAllowed: method === "GET",
    };
  }

  const hasJobId = typeof payload?.request_id === "string" && payload.request_id.trim().length > 0
    || typeof payload?.id === "string" && payload.id.trim().length > 0;
  const hasVideo = typeof payload?.url === "string" && payload.url.trim().length > 0
    || typeof payload?.video?.url === "string" && payload.video.url.trim().length > 0;
  const inProgress = ["pending", "queued", "processing"].includes(status);
  const completed = ["done", "completed", "succeeded"].includes(status);
  const accepted = method === "POST"
    ? hasJobId || hasVideo
    : hasVideo || inProgress || completed && (hasJobId || hasVideo);

  return accepted
    ? { ok: true }
    : { ok: false, errorKind: "invalid_upstream_json", message: "Upstream returned an invalid video response", fallbackAllowed: method === "GET" };
}

function evidenceFromStreamPayload(payload, format, eventName) {
  if (format === FORMATS.OPENAI_RESPONSES) {
    if (["response.output_text.delta", "response.reasoning_summary_text.delta", "response.reasoning_text.delta"].includes(eventName)) {
      return typeof payload?.delta === "string" && payload.delta.length > 0 ? eventName : null;
    }
    const item = payload?.item;
    if (item && ["function_call", "custom_tool_call", "image_generation_call", "computer_call"].includes(item.type)) return item.type;
    return hasResponsesEvidence(payload) ? "responses_output" : null;
  }
  if (format === FORMATS.CLAUDE) {
    if (payload?.type === "content_block_start" && payload?.content_block?.type === "tool_use") return "tool_call";
    if (payload?.type === "content_block_delta") {
      if (typeof payload?.delta?.text === "string" && payload.delta.text.length > 0) return "text";
      if (typeof payload?.delta?.thinking === "string" && payload.delta.thinking.length > 0) return "thinking";
      if (typeof payload?.delta?.partial_json === "string" && payload.delta.partial_json.length > 0) return "tool_call";
    }
    return null;
  }
  if ([FORMATS.GEMINI, FORMATS.GEMINI_CLI, FORMATS.VERTEX, FORMATS.ANTIGRAVITY].includes(format)) {
    return hasGeminiEvidence(payload) ? "gemini_part" : null;
  }
  if (format === FORMATS.OLLAMA) {
    if (typeof payload?.message?.content === "string" && payload.message.content.length > 0) return "text";
    if (typeof payload?.response === "string" && payload.response.length > 0) return "text";
    if (Array.isArray(payload?.message?.tool_calls) && payload.message.tool_calls.length > 0) return "tool_call";
    return null;
  }
  const delta = payload?.choices?.[0]?.delta;
  if (typeof delta?.content === "string" && delta.content.length > 0) return "text";
  if (typeof delta?.reasoning_content === "string" && delta.reasoning_content.length > 0) return "thinking";
  if (Array.isArray(delta?.tool_calls) && delta.tool_calls.length > 0) return "tool_call";
  return hasGeminiEvidence(payload) ? "gemini_part" : null;
}

export function createStreamingOutcomeTracker({ format, committed = false } = {}) {
  let state = OUTCOME_STATE.PENDING;
  let error = null;
  let errorKind = null;
  let terminalClass = null;
  let terminalKind = null;
  let usefulOutputSeen = false;
  const usefulEvidence = new Set();
  let upstreamBytesSeen = 0;
  let downstreamCommitted = committed;
  let clientDisconnected = false;

  const fail = (kind, message) => {
    if (state === OUTCOME_STATE.CLIENT_ABORTED || terminalClass === "failure") return snapshot();
    errorKind = kind || "upstream_payload_error";
    error = message || "Upstream stream failed";
    terminalClass = "failure";
    state = downstreamCommitted ? OUTCOME_STATE.COMMITTED_FAILURE : OUTCOME_STATE.PRECOMMIT_FAILURE;
    return snapshot();
  };

  const observe = ({ event = null, data, bytes = 0, doneSentinel = false, malformed = false } = {}) => {
    upstreamBytesSeen += bytes || 0;
    if (state === OUTCOME_STATE.CLIENT_ABORTED || terminalClass === "failure") return snapshot();
    if (malformed) return fail("invalid_upstream_json", "Upstream SSE contained malformed JSON");

    const payloadError = extractPayloadError(data);
    const eventType = event || data?.type || null;
    if (payloadError) return fail(payloadError.errorKind, payloadError.message);

    if (format === FORMATS.OPENAI_RESPONSES) {
      const status = data?.response?.status || data?.status;
      if (RESPONSES_FAILURE.has(eventType) || status === "failed" || status === "incomplete") {
        return fail(status === "incomplete" || eventType === "response.incomplete" ? "upstream_incomplete" : "upstream_payload_error", asMessage(data?.response?.error || data?.error, `Upstream emitted ${eventType || status}`));
      }
      if (RESPONSES_SUCCESS.has(eventType) || status === "completed") {
        terminalClass = "success";
        terminalKind = eventType || status;
      }
    } else if (format === FORMATS.CLAUDE) {
      if (eventType === "error" || data?.type === "error") return fail("upstream_payload_error", asMessage(data?.error, "Claude stream emitted an error"));
      if (eventType === "message_stop" || data?.type === "message_stop") {
        terminalClass = "success";
        terminalKind = "message_stop";
      }
    } else if ([FORMATS.GEMINI, FORMATS.GEMINI_CLI, FORMATS.VERTEX, FORMATS.ANTIGRAVITY].includes(format)) {
      const finish = data?.response?.candidates?.[0]?.finishReason || data?.candidates?.[0]?.finishReason;
      if (finish) {
        terminalClass = "success";
        terminalKind = finish;
      }
    } else if (format === FORMATS.OLLAMA) {
      if (data?.done === true) {
        terminalClass = "success";
        terminalKind = "done";
      }
    } else {
      const finish = data?.choices?.[0]?.finish_reason;
      if (finish != null) {
        terminalClass = "success";
        terminalKind = finish;
      }
      if (doneSentinel) {
        terminalClass = "success";
        terminalKind = "done";
      }
    }

    const evidence = evidenceFromStreamPayload(data, format, eventType);
    if (evidence) {
      usefulOutputSeen = true;
      usefulEvidence.add(evidence);
    }
    return snapshot();
  };

  const commit = () => {
    downstreamCommitted = true;
    return snapshot();
  };

  const finish = () => {
    if (state === OUTCOME_STATE.CLIENT_ABORTED || terminalClass === "failure") return snapshot();
    if (terminalClass === "success") state = OUTCOME_STATE.OK;
    else fail("upstream_incomplete", "Upstream stream ended without a valid terminal event");
    return snapshot();
  };

  const abortClient = (message = "Client disconnected") => {
    clientDisconnected = true;
    errorKind = "aborted";
    error = message;
    state = OUTCOME_STATE.CLIENT_ABORTED;
    return snapshot();
  };

  function snapshot() {
    return {
      state,
      ok: state === OUTCOME_STATE.OK,
      error,
      errorKind,
      terminalClass,
      terminalKind,
      usefulOutputSeen,
      usefulEvidence: [...usefulEvidence],
      upstreamBytesSeen,
      downstreamCommitted,
      clientDisconnected,
      fallbackAllowed: state === OUTCOME_STATE.PRECOMMIT_FAILURE,
    };
  }

  return { observe, fail, commit, finish, abortClient, snapshot };
}

export function parseSSEBlocks(text, onEvent) {
  const normalized = text.replace(/\r\n/g, "\n");
  const blocks = normalized.split("\n\n");
  const remainder = blocks.pop() || "";
  for (const block of blocks) {
    let event = null;
    const dataLines = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
      else if (line.trim().startsWith("{")) dataLines.push(line.trim());
    }
    const raw = dataLines.join("\n").trim();
    if (!raw) continue;
    if (raw === "[DONE]") {
      onEvent({ event, data: null, doneSentinel: true });
      continue;
    }
    try {
      onEvent({ event, data: JSON.parse(raw), doneSentinel: false });
    } catch {
      onEvent({ event, data: { error: { message: raw.slice(0, 200) } }, malformed: true });
    }
  }
  return remainder;
}
