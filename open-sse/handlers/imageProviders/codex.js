// Codex (ChatGPT Plus/Pro) image generation via Responses API + SSE
import { randomUUID } from "node:crypto";
import { nowSec } from "./_base.js";
import { PROVIDERS } from "../../config/providers.js";
import { extractPayloadError } from "../../utils/upstreamOutcome.js";

const CODEX_RESPONSES_URL = PROVIDERS["codex"].baseUrl;
const CODEX_USER_AGENT = "codex_cli_rs/0.136.0";
const CODEX_VERSION = "0.136.0";
const CODEX_ORIGINATOR = "codex_cli_rs";
const CODEX_MODEL_SUFFIX = "-image";
const CODEX_REF_DETAIL = "high";

function decodeAccountId(idToken) {
  try {
    const parts = String(idToken || "").split(".");
    if (parts.length !== 3) return null;
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const pad = (4 - (b64.length % 4)) % 4;
    const payload = JSON.parse(Buffer.from(b64 + "=".repeat(pad), "base64").toString("utf8"));
    return payload?.["https://api.openai.com/auth"]?.chatgpt_account_id || null;
  } catch {
    return null;
  }
}

function stripImageSuffix(model) {
  return model.endsWith(CODEX_MODEL_SUFFIX) ? model.slice(0, -CODEX_MODEL_SUFFIX.length) : model;
}

function toDataUrl(input) {
  if (!input || typeof input !== "string") return null;
  if (/^data:image\//i.test(input) || /^https?:\/\//i.test(input)) return input;
  return `data:image/png;base64,${input}`;
}

function buildContent(prompt, refs, detail = CODEX_REF_DETAIL) {
  const content = [];
  refs.forEach((url, index) => {
    content.push({ type: "input_text", text: `<image name=image${index + 1}>` });
    content.push({ type: "input_image", image_url: url, detail });
    content.push({ type: "input_text", text: "</image>" });
  });
  content.push({ type: "input_text", text: prompt });
  return content;
}

// Parse Codex SSE stream → final base64 image. Optional callbacks for client streaming.
async function parseStream(response, log, callbacks = {}) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let imageB64 = null;
  let streamError = null;
  let terminalSeen = false;
  let lastEvent = null;
  let bytesReceived = 0;
  let lastProgressLogMs = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytesReceived += value?.byteLength || 0;
    buffer += decoder.decode(value, { stream: true });

    let sepIdx;
    while ((sepIdx = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, sepIdx);
      buffer = buffer.slice(sepIdx + 2);

      const lines = block.split("\n");
      let eventName = null;
      let dataStr = "";
      for (const line of lines) {
        if (line.startsWith("event:")) eventName = line.slice(6).trim();
        else if (line.startsWith("data:")) dataStr += line.slice(5).trim();
      }
      if (!eventName) continue;
      if (eventName !== lastEvent) {
        log?.info?.("IMAGE", `codex progress: ${eventName}`);
        lastEvent = eventName;
      }

      const now = Date.now();
      if (callbacks.onProgress && now - lastProgressLogMs > 200) {
        lastProgressLogMs = now;
        callbacks.onProgress({ stage: eventName, bytesReceived });
      }

      let data = null;
      if (dataStr && dataStr !== "[DONE]") {
        try {
          data = JSON.parse(dataStr);
        } catch {
          streamError = { errorKind: "invalid_upstream_json", message: "Codex image stream contained malformed JSON" };
          continue;
        }
      }
      const payloadError = extractPayloadError(data);
      if (payloadError || eventName === "response.failed" || eventName === "response.incomplete" || eventName === "error") {
        streamError = payloadError || {
          errorKind: eventName === "response.incomplete" ? "upstream_incomplete" : "upstream_payload_error",
          message: data?.response?.error?.message || data?.error?.message || `Codex image stream emitted ${eventName}`,
        };
      }
      if (eventName === "response.completed" || eventName === "response.done" || eventName === "response.failed" || eventName === "response.incomplete") {
        terminalSeen = true;
      }

      if (eventName === "response.image_generation_call.partial_image" && data) {
        if (callbacks.onPartialImage && data?.partial_image_b64) {
          callbacks.onPartialImage({ b64_json: data.partial_image_b64, index: data.partial_image_index });
        }
      }

      if (eventName === "response.output_item.done" && data) {
        const item = data?.item;
        if (item?.type === "image_generation_call" && item.result) {
          imageB64 = item.result;
        }
      }
    }
  }
  const remaining = decoder.decode();
  if (remaining) buffer += remaining;
  if (buffer.trim()) {
    streamError = streamError || { errorKind: "invalid_upstream_json", message: "Codex image stream ended with an incomplete SSE event" };
  }
  if (streamError) {
    const error = new Error(streamError.message || "Codex image stream failed");
    error.errorKind = streamError.errorKind || "upstream_payload_error";
    throw error;
  }
  if (!terminalSeen) {
    const error = new Error("Codex image stream ended without a terminal event");
    error.errorKind = "upstream_incomplete";
    throw error;
  }
  return imageB64;
}

// SSE Response that pipes codex progress + partial + done events to client.
// The ready promise is a precommit barrier: callers do not expose the Response
// until image evidence is seen or the upstream fails first.
function buildSseResponse(providerResponse, log, onSuccess) {
  let settleReady;
  let readySettled = false;
  const ready = new Promise((resolve) => { settleReady = resolve; });
  const settle = (outcome) => {
    if (readySettled) return;
    readySettled = true;
    settleReady(outcome);
  };

  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      const send = (event, data) => {
        controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      try {
        const b64 = await parseStream(providerResponse, log, {
          onProgress: (info) => send("progress", info),
          onPartialImage: (info) => {
            settle({ ok: true });
            send("partial_image", info);
          },
        });
        if (!b64) {
          const message = "Codex did not return an image. Account may not be entitled (Plus/Pro required).";
          settle({ ok: false, errorKind: "empty_upstream_response", message });
          send("error", { message });
        } else {
          settle({ ok: true });
          if (onSuccess) await onSuccess();
          send("done", { created: nowSec(), data: [{ b64_json: b64 }] });
        }
      } catch (err) {
        settle({ ok: false, errorKind: err?.errorKind || "upstream_payload_error", message: err?.message || "Stream failed" });
        send("error", { message: err?.message || "Stream failed", errorKind: err?.errorKind || "upstream_payload_error" });
      } finally {
        controller.close();
      }
    },
  });
  const response = new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
      "Access-Control-Allow-Origin": "*",
    },
  });
  return { response, ready };
}

export default {
  stream: true,
  buildUrl: () => CODEX_RESPONSES_URL,
  buildHeaders: (creds) => {
    const accountId = creds?.providerSpecificData?.chatgptAccountId || decodeAccountId(creds?.idToken);
    return {
      "accept": "text/event-stream, application/json",
      "authorization": `Bearer ${creds?.accessToken || ""}`,
      "chatgpt-account-id": accountId || "",
      "content-type": "application/json",
      "originator": CODEX_ORIGINATOR,
      "session_id": randomUUID(),
      "user-agent": CODEX_USER_AGENT,
      "version": CODEX_VERSION,
      "x-client-request-id": randomUUID(),
    };
  },
  buildBody: (model, body) => {
    const refs = [];
    if (Array.isArray(body.images)) body.images.forEach((i) => { const u = toDataUrl(i); if (u) refs.push(u); });
    const single = toDataUrl(body.image);
    if (single) refs.push(single);
    const detail = body.image_detail || CODEX_REF_DETAIL;
    const imgTool = { type: "image_generation", output_format: (body.output_format || "png").toLowerCase() };
    if (body.size && body.size !== "") imgTool.size = body.size;
    if (body.quality && body.quality !== "") imgTool.quality = body.quality;
    if (body.background && body.background !== "") imgTool.background = body.background;
    return {
      model: stripImageSuffix(model),
      instructions: "",
      input: [{ type: "message", role: "user", content: buildContent(body.prompt, refs, detail) }],
      tools: [imgTool],
      tool_choice: "auto",
      parallel_tool_calls: false,
      prompt_cache_key: randomUUID(),
      stream: true,
      store: false,
      reasoning: null,
    };
  },
  // Custom: codex parses SSE → either pipe to client or collect b64
  async parseResponse(response, { log, streamToClient, onRequestSuccess }) {
    if (streamToClient) {
      const streamResult = buildSseResponse(response, log, onRequestSuccess);
      return { sseResponse: streamResult.response, precommit: streamResult.ready };
    }
    const b64 = await parseStream(response, log);
    if (!b64) {
      throw new Error("Codex did not return an image. Account may not be entitled (Plus/Pro required).");
    }
    return { created: nowSec(), data: [{ b64_json: b64 }] };
  },
  normalize: (responseBody) => responseBody,
};
