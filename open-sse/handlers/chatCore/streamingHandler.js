import { FORMATS } from "../../translator/formats.js";
import { needsTranslation } from "../../translator/index.js";
import { createSSETransformStreamWithLogger, createPassthroughStreamWithLogger } from "../../utils/stream.js";
import { createOutcomeTrackingStream, createPrecommitStream, pipeWithDisconnect, streamFromPrecommit } from "../../utils/streamHandler.js";
import { createErrorResult } from "../../utils/error.js";
import { createStreamingOutcomeTracker } from "../../utils/upstreamOutcome.js";
import { PROVIDERS } from "../../config/providers.js";
import { STREAM_STALL_TIMEOUT_MS } from "../../config/runtimeConfig.js";
import { buildAbortedResponsesTerminalBytes } from "../../utils/responsesStreamHelpers.js";
import { buildRequestDetail, extractRequestConfig, saveUsageStats, formatDoneLine } from "./requestDetail.js";
import { saveRequestDetail } from "@/lib/usageDb.js";
import { SSE_HEADERS_CORS as SSE_HEADERS } from "../../utils/sseConstants.js";

// Codex returns Responses API SSE → which client format to translate INTO, by request sourceFormat.
// Gemini-family all map to ANTIGRAVITY decoder; unknown sources fall back to OPENAI.
const CODEX_SOURCE_TO_TARGET = {
  [FORMATS.OPENAI_RESPONSES]: FORMATS.OPENAI_RESPONSES,
  [FORMATS.CLAUDE]: FORMATS.CLAUDE,
  [FORMATS.ANTIGRAVITY]: FORMATS.ANTIGRAVITY,
  [FORMATS.GEMINI]: FORMATS.ANTIGRAVITY,
  [FORMATS.GEMINI_CLI]: FORMATS.ANTIGRAVITY,
};

/**
 * Determine which SSE transform stream to use based on provider/format.
 */
function buildTransformStream({ provider, sourceFormat, targetFormat, userAgent, reqLogger, toolNameMap, customToolNames, model, connectionId, body, onStreamComplete, outcomeTracker, apiKey }) {
  const isDroidCLI = userAgent?.toLowerCase().includes("droid") || userAgent?.toLowerCase().includes("codex-cli");
  // Responses-API providers (e.g. codex) emit Responses SSE → translate into client format
  const isResponsesProvider = PROVIDERS[provider]?.format === FORMATS.OPENAI_RESPONSES;
  const needsCodexTranslation = isResponsesProvider && targetFormat === FORMATS.OPENAI_RESPONSES && !isDroidCLI;

  if (needsCodexTranslation) {
    const codexTarget = CODEX_SOURCE_TO_TARGET[sourceFormat] || FORMATS.OPENAI;
    return createSSETransformStreamWithLogger(FORMATS.OPENAI_RESPONSES, codexTarget, provider, reqLogger, toolNameMap, model, connectionId, body, onStreamComplete, apiKey, customToolNames, outcomeTracker);
  }

  if (needsTranslation(targetFormat, sourceFormat)) {
    return createSSETransformStreamWithLogger(targetFormat, sourceFormat, provider, reqLogger, toolNameMap, model, connectionId, body, onStreamComplete, apiKey, customToolNames, outcomeTracker);
  }

  return createPassthroughStreamWithLogger(provider, reqLogger, model, connectionId, body, onStreamComplete, apiKey, outcomeTracker);
}

/**
 * Handle streaming response — pipe provider SSE through transform stream to client.
 */
export async function handleStreamingResponse({ providerResponse, provider, model, sourceFormat, targetFormat, userAgent, body, stream, translatedBody, finalBody, requestStartTime, connectionId, apiKey, clientRawRequest, onRequestSuccess, requestSignal, reqLogger, toolNameMap, customToolNames, streamController, onStreamComplete, trackDone, appendLog, pxpipe, reqTag, log }) {
  const outcomeTracker = createStreamingOutcomeTracker({ format: targetFormat });

  // When upstream returns HTML/text instead of SSE (e.g. Cloudflare 5xx error
  // page), consume it before downstream commit and return a routable gateway error.
  const upstreamContentType = (providerResponse.headers.get("content-type") || "").toLowerCase();
  if (upstreamContentType && !upstreamContentType.includes("text/event-stream") && !upstreamContentType.includes("application/json")) {
    const bodyText = await providerResponse.text().catch(() => "");
    const titleMatch = bodyText.match(/<title>([^<]+)<\/title>/i);
    const sanitizedTitle = (titleMatch?.[1] || "").replace(/<[^>]*>/g, "").replace(/[\r\n]+/g, " ").trim().slice(0, 160);
    const shortMsg = sanitizedTitle
      || (bodyText.length < 200 ? bodyText.replace(/<[^>]*>/g, "").trim().slice(0, 160) : `Upstream returned non-SSE response (${upstreamContentType})`);
    if (log?.errorLine) log.errorLine(reqTag, "✗", `BLOCKED 502 · ${provider}/${model} · non-SSE (${upstreamContentType})\n    ${shortMsg}`);
    const outcome = outcomeTracker.fail(
      "invalid_upstream_content_type",
      shortMsg || "Upstream returned invalid streaming content"
    );
    trackDone?.();
    appendLog?.({ status: "FAILED 502" });
    onStreamComplete?.({ content: "", thinking: "" }, null, null, outcome);
    return createErrorResult(502, outcome.error, undefined, outcome.errorKind);
  }

  let successNotified = false;
  const notifySuccess = () => {
    if (successNotified || !onRequestSuccess) return;
    successNotified = true;
    Promise.resolve()
      .then(onRequestSuccess)
      .catch((error) => {
        console.error("[ChatCore] onRequestSuccess failed:", error?.message || error);
      });
  };
  const stallTimeoutMs = PROVIDERS[provider]?.stallTimeoutMs || STREAM_STALL_TIMEOUT_MS;
  const precommitSignal = requestSignal || streamController?.signal;
  const precommit = await createPrecommitStream(providerResponse, outcomeTracker, {
    signal: precommitSignal,
    stallTimeoutMs,
  });

  if (!precommit.ok) {
    const outcome = precommit.outcome;
    const aborted = outcome.state === "client_aborted";
    const status = aborted ? 499 : 502;
    trackDone?.();
    appendLog?.({ status: `FAILED ${status}` });
    onStreamComplete?.(
      { content: "", thinking: "" },
      null,
      null,
      outcome
    );
    if (aborted) {
      return createErrorResult(499, outcome.error || "Request aborted", undefined, "aborted");
    }
    return createErrorResult(502, outcome.error || "Upstream stream failed before output", undefined, outcome.errorKind || "upstream_incomplete");
  }

  // Rebuild the provider body from the single precommit reader. Buffered bytes are
  // replayed losslessly, then the same reader continues with normal backpressure.
  const committedBody = streamFromPrecommit({
    reader: precommit.reader,
    buffered: precommit.buffered,
    ended: precommit.ended,
    onClientCancel: (reason) => {
      outcomeTracker.abortClient(typeof reason === "string" ? reason : "Client disconnected");
      streamController?.handleDisconnect?.(reason || "cancelled");
    },
    // Lifecycle classification/finalization is owned by pipeWithDisconnect so a
    // single idempotent path handles resets, stalls and downstream cancellation.
    onUpstreamError: () => {},
  }).pipeThrough(createOutcomeTrackingStream(outcomeTracker));
  const committedResponse = new Response(committedBody, {
    status: providerResponse.status,
    statusText: providerResponse.statusText,
    headers: providerResponse.headers,
  });

  const finalizeStream = (contentObj, usage, ttftAt, outcome) => {
    if (outcome?.ok) notifySuccess();
    onStreamComplete?.(contentObj, usage, ttftAt, outcome);
  };
  const transformStream = buildTransformStream({ provider, sourceFormat, targetFormat, userAgent, reqLogger, toolNameMap, customToolNames, model, connectionId, body, onStreamComplete: finalizeStream, outcomeTracker, apiKey });
  const isResponsesPassthrough = sourceFormat === FORMATS.OPENAI_RESPONSES && targetFormat === FORMATS.OPENAI_RESPONSES;
  const onAbortTerminal = isResponsesPassthrough ? buildAbortedResponsesTerminalBytes : null;
  const transformedBody = pipeWithDisconnect(
    committedResponse,
    transformStream,
    streamController,
    onAbortTerminal,
    stallTimeoutMs,
    {
      onError: (error) => {
        const outcome = outcomeTracker.fail(
          error?.errorKind || "upstream_reset",
          error?.message || "Upstream stream failed after commit"
        );
        transformStream.abortOutcome?.(outcome);
      },
      onCancel: (reason) => {
        const outcome = outcomeTracker.abortClient(
          typeof reason === "string" ? reason : "Client disconnected"
        );
        transformStream.abortOutcome?.(outcome);
      },
    }
  );

  return {
    success: true,
    response: new Response(transformedBody, { headers: SSE_HEADERS })
  };
}

/**
 * Build onStreamComplete callback for streaming usage tracking.
 */
export function buildOnStreamComplete({ provider, model, connectionId, apiKey, requestStartTime, body, stream, finalBody, translatedBody, clientRawRequest, pxpipe, reqTag, log }) {
  const streamDetailId = `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;

  const onStreamComplete = (contentObj, usage, ttftAt, outcome = { state: "ok", ok: true }) => {
    const latency = {
      ttft: ttftAt ? ttftAt - requestStartTime : Date.now() - requestStartTime,
      total: Date.now() - requestStartTime
    };
    const succeeded = outcome.ok === true || outcome.state === "ok";
    const aborted = outcome.state === "client_aborted";
    const safeContent = contentObj?.content || null;
    const safeThinking = contentObj?.thinking || null;

    saveRequestDetail(buildRequestDetail({
      provider, model, connectionId,
      latency,
      tokens: succeeded && usage ? usage : { prompt_tokens: 0, completion_tokens: 0 },
      request: extractRequestConfig(body, stream),
      providerRequest: finalBody || translatedBody || null,
      providerResponse: succeeded ? safeContent : { error: outcome.error, errorKind: outcome.errorKind },
      response: succeeded
        ? { content: safeContent, thinking: safeThinking, type: "streaming" }
        : { error: outcome.error || (aborted ? "Client disconnected" : "Upstream stream failed"), errorKind: outcome.errorKind, type: "streaming" },
      pxpipe,
      status: succeeded ? "success" : (aborted ? "aborted" : "error")
    }, { id: streamDetailId })).catch(err => {
      console.error("[RequestDetail] Failed to finalize streaming content:", err.message);
    });

    if (!succeeded) {
      if (log?.errorLine && !aborted) log.errorLine(reqTag, "✗", `STREAM FAILED · ${provider}/${model} · ${outcome.errorKind || "upstream_error"}`);
      return;
    }

    // Persist usage and clear account state only after a protocol-valid terminal.
    saveUsageStats({ provider, model, tokens: usage, connectionId, apiKey, endpoint: clientRawRequest?.endpoint, label: "STREAM USAGE", silent: true });
    if (log?.line) log.line(reqTag, "📊", formatDoneLine({ usage, latency }));
  };

  return { onStreamComplete, streamDetailId };
}
