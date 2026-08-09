// Stream handler with disconnect detection - shared for all providers
import { STREAM_STALL_TIMEOUT_MS } from "../config/runtimeConfig.js";
import { dbg, isDebugEnabled } from "./debugLog.js";
import { parseSSEBlocks } from "./upstreamOutcome.js";

// Get HH:MM:SS timestamp
function getTimeString() {
  return new Date().toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/**
 * Create stream controller with abort and disconnect detection
 * @param {object} options
 * @param {function} options.onDisconnect - Callback when client disconnects
 * @param {object} options.log - Logger instance
 * @param {string} options.provider - Provider name
 * @param {string} options.model - Model name
 */
export function createStreamController({ onDisconnect, onError, log, provider, model, reqTag = "" } = {}) {
  const abortController = new AbortController();
  const startTime = Date.now();
  let disconnected = false;
  let abortTimeout = null;

  // Only abnormal terminations are logged; normal completion is covered by "📊 done".
  // isError uses errorLine (always shown, ignores LOG_LEVEL) so failures survive quiet levels.
  const logStream = (symbol, status, isError = false) => {
    const duration = Date.now() - startTime;
    const emit = isError ? log?.errorLine : log?.line;
    if (emit) emit(reqTag, symbol, `${status} · ${provider}/${model} · ${duration}ms`);
    else console.log(`[${getTimeString()}] ${symbol} ${provider}/${model} · ${status} · ${duration}ms`);
  };

  return {
    signal: abortController.signal,
    startTime,

    isConnected: () => !disconnected,

    // Call when client disconnects
    handleDisconnect: (reason = "client_closed") => {
      if (disconnected) return;
      disconnected = true;

      logStream("⚡", `DISCONNECT: ${reason}`);
      dbg("CTRL", `${provider}/${model} | disconnect=${reason} | dur=${Date.now() - startTime}ms`);

      // Delay abort to allow cleanup
      abortTimeout = setTimeout(() => {
        abortController.abort();
      }, 500);

      onDisconnect?.({ reason, duration: Date.now() - startTime });
    },

    // Call when stream completes normally (no line here — "📊 done" is authoritative)
    handleComplete: () => {
      if (disconnected) return;
      disconnected = true;

      if (abortTimeout) {
        clearTimeout(abortTimeout);
        abortTimeout = null;
      }
    },

    // Call on error
    handleError: (error) => {
      if (disconnected) return;
      disconnected = true;

      if (abortTimeout) {
        clearTimeout(abortTimeout);
        abortTimeout = null;
      }

      if (error.name === "AbortError") {
        logStream("⚡", "ABORTED");
        return;
      }

      logStream("✗", `ERROR: ${error.message}${error.stack ? `\n    ${error.stack}` : ""}`, true);
      onError?.(error);
    },

    abort: () => abortController.abort()
  };
}

/**
 * Create transform stream with disconnect detection
 * Wraps existing transform stream and adds abort capability.
 *
 * Stall detection lives in pipeWithDisconnect (tied to upstream byte
 * activity), not here — output of the transform stream may be silent
 * for long periods while raw bytes still flow (e.g. Kiro EventStream
 * binary frames buffering, Claude reasoning streams).
 */
export function createDisconnectAwareStream(transformStream, streamController, onAbortTerminal = null, lifecycle = {}) {
  const reader = transformStream.readable.getReader();
  const writer = transformStream.writable?.getWriter?.() || null;
  let terminalEmitted = false;
  let settled = false;

  const settle = (kind, value) => {
    if (settled) return;
    settled = true;
    lifecycle?.[kind]?.(value);
  };

  // Emit a synthesized terminal payload (e.g. Responses response.failed + [DONE]) once.
  // This is wire compatibility only; lifecycle still records a committed failure.
  const emitTerminal = (controller) => {
    if (terminalEmitted || !onAbortTerminal) return;
    terminalEmitted = true;
    try {
      const bytes = onAbortTerminal();
      if (bytes) controller.enqueue(bytes);
    } catch { /* best-effort terminal */ }
  };

  return new ReadableStream({
    async pull(controller) {
      if (!streamController.isConnected()) {
        const error = new Error("stream terminated before completion");
        error.errorKind = "upstream_reset";
        settle("onError", error);
        emitTerminal(controller);
        controller.close();
        return;
      }

      try {
        const { done, value } = await reader.read();

        if (done) {
          settle("onComplete");
          streamController.handleComplete();
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        const msg = error?.message || "";
        const isControllerClosed = msg.includes("already closed") || msg.includes("Invalid state");
        if (!error?.errorKind && !isControllerClosed) error.errorKind = "upstream_reset";
        if (!isControllerClosed) streamController.handleError(error);
        settle("onError", error);
        reader.cancel().catch(() => {});
        writer?.abort?.().catch(() => {});

        try {
          if (onAbortTerminal) {
            emitTerminal(controller);
            controller.close();
          } else {
            controller.error(error);
          }
        } catch { /* already closed or cancelled */ }
      }
    },

    cancel(reason) {
      settle("onCancel", reason);
      streamController.handleDisconnect(reason || "cancelled");
      reader.cancel(reason).catch(() => {});
      writer?.abort?.(reason).catch(() => {});
    }
  });
}

/**
 * Pipe provider response through transform with disconnect detection.
 *
 * Stall watchdog tracks raw upstream byte activity, not transform output.
 * Reasoning models (Claude thinking via Kiro, etc.) can produce zero SSE
 * output for long stretches while partial EventStream frames keep arriving.
 * Measuring stall on the transform output caused false stalls and the
 * "failed to pipe response" error in Next.
 *
 * Any upstream chunk resets the timer. If no bytes arrive for
 * STREAM_STALL_TIMEOUT_MS, abort the underlying fetch via the controller.
 *
 * @param {Response} providerResponse - Response from provider
 * @param {TransformStream} transformStream - Transform stream for SSE
 * @param {object} streamController - Stream controller from createStreamController
 */
export async function createPrecommitStream(providerResponse, outcomeTracker, {
  signal,
  stallTimeoutMs = STREAM_STALL_TIMEOUT_MS,
  maxBufferedBytes = 1024 * 1024,
} = {}) {
  if (!providerResponse?.body) {
    return { ok: false, outcome: outcomeTracker.fail("empty_upstream_response", "Upstream returned no response body") };
  }

  const reader = providerResponse.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const buffered = [];
  let bufferedBytes = 0;
  let parseBuffer = "";
  let stallTimer = null;
  let stalled = false;
  let stallReject = null;

  const clearStall = () => {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = null;
  };
  const armStall = () => {
    clearStall();
    stallTimer = setTimeout(() => {
      stalled = true;
      const error = new Error("stream stall timeout");
      error.errorKind = "upstream_stall";
      stallReject?.(error);
      reader.cancel(error).catch(() => {});
    }, stallTimeoutMs);
  };
  const readWithStall = () => new Promise((resolve, reject) => {
    stallReject = reject;
    armStall();
    reader.read().then(resolve, reject).finally(() => {
      stallReject = null;
      clearStall();
    });
  });

  let externalAbort = false;
  const cancelForAbort = () => {
    externalAbort = true;
    reader.cancel("request aborted").catch(() => {});
    stallReject?.(Object.assign(new Error("request aborted"), { errorKind: "aborted" }));
  };
  if (signal?.aborted) {
    cancelForAbort();
    return { ok: false, outcome: outcomeTracker.abortClient() };
  }
  signal?.addEventListener?.("abort", cancelForAbort, { once: true });

  try {
    while (true) {
      let result;
      try {
        result = await readWithStall();
      } catch (error) {
        if (externalAbort || signal?.aborted) return { ok: false, outcome: outcomeTracker.abortClient("Request aborted") };
        const kind = error?.errorKind || (stalled ? "upstream_stall" : "upstream_reset");
        return { ok: false, outcome: outcomeTracker.fail(kind, error?.message || "Upstream stream failed before output") };
      }

      if (result.done) {
        const remaining = decoder.decode();
        if (remaining) parseBuffer += remaining;
        if (parseBuffer.trim()) {
          parseSSEBlocks(`${parseBuffer}\n\n`, (event) => outcomeTracker.observe(event));
        }
        const outcome = outcomeTracker.finish();
        if (outcome.ok) {
          outcomeTracker.commit();
          return { ok: true, reader, buffered, outcome: outcomeTracker.snapshot(), ended: true };
        }
        return { ok: false, outcome };
      }

      const value = result.value;
      buffered.push(value);
      bufferedBytes += value?.byteLength || 0;
      if (bufferedBytes > maxBufferedBytes) {
        await reader.cancel("precommit buffer exceeded").catch(() => {});
        return { ok: false, outcome: outcomeTracker.fail("invalid_upstream_json", "Upstream produced too much metadata before useful output") };
      }

      parseBuffer += decoder.decode(value, { stream: true });
      parseBuffer = parseSSEBlocks(parseBuffer, (event) => {
        outcomeTracker.observe({ ...event, bytes: value?.byteLength || 0 });
      });
      const outcome = outcomeTracker.snapshot();
      if (outcome.terminalClass === "failure") {
        await reader.cancel(outcome.error).catch(() => {});
        return { ok: false, outcome };
      }
      if (outcome.usefulOutputSeen || outcome.terminalClass === "success") {
        outcomeTracker.commit();
        return { ok: true, reader, buffered, outcome: outcomeTracker.snapshot(), ended: false };
      }
    }
  } finally {
    clearStall();
    signal?.removeEventListener?.("abort", cancelForAbort);
  }
}

export function createOutcomeTrackingStream(outcomeTracker) {
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let buffer = "";
  return new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      buffer = parseSSEBlocks(buffer, (event) => {
        outcomeTracker.observe({ ...event, bytes: chunk?.byteLength || 0 });
      });
      controller.enqueue(chunk);
    },
    flush() {
      const remaining = decoder.decode();
      if (remaining) buffer += remaining;
      if (buffer.trim()) parseSSEBlocks(`${buffer}\n\n`, (event) => outcomeTracker.observe(event));
    },
  });
}

export function streamFromPrecommit({ reader, buffered, ended = false, onClientCancel = null, onUpstreamError = null }) {
  let index = 0;
  return new ReadableStream({
    async pull(controller) {
      if (index < buffered.length) {
        controller.enqueue(buffered[index++]);
        return;
      }
      if (ended) {
        controller.close();
        return;
      }
      try {
        const { done, value } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (error) {
        onUpstreamError?.(error);
        controller.error(error);
      }
    },
    cancel(reason) {
      onClientCancel?.(reason);
      return reader.cancel(reason);
    },
  });
}

export function pipeWithDisconnect(providerResponse, transformStream, streamController, onAbortTerminal = null, stallTimeoutMs = STREAM_STALL_TIMEOUT_MS, lifecycle = {}) {
  let stallTimer = null;
  let terminated = false;
  let lifecycleSettled = false;
  let chunkCount = 0;
  let totalBytes = 0;
  let lastChunkAt = Date.now();
  const t0 = Date.now();
  const tag = "STREAM";
  const clearStall = () => {
    if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; }
  };
  const settleLifecycle = (kind, value) => {
    if (lifecycleSettled) return;
    lifecycleSettled = true;
    lifecycle?.[kind]?.(value);
  };
  const armStall = () => {
    clearStall();
    if (terminated) return;
    stallTimer = setTimeout(() => {
      stallTimer = null;
      if (terminated) return;
      terminated = true;
      const error = new Error("stream stall timeout");
      error.errorKind = "upstream_stall";
      dbg(tag, `STALL TIMEOUT ${stallTimeoutMs}ms | chunks=${chunkCount} | bytes=${totalBytes} | sinceLast=${Date.now() - lastChunkAt}ms`);
      settleLifecycle("onError", error);
      streamController.handleError?.(error);
      streamController.abort?.();
    }, stallTimeoutMs);
  };

  // Wrap controller so every termination path clears the stall timer.
  // Without this, abort/cancel/downstream-error paths leave the timer armed
  // and a stale abort could fire after the request has already ended.
  const wrappedController = {
    signal: streamController.signal,
    startTime: streamController.startTime,
    isConnected: () => streamController.isConnected(),
    handleComplete: () => { terminated = true; settleLifecycle("onComplete"); dbg(tag, `complete | chunks=${chunkCount} | bytes=${totalBytes} | dur=${Date.now() - t0}ms`); clearStall(); streamController.handleComplete(); },
    handleError: (e) => { terminated = true; settleLifecycle("onError", e); dbg(tag, `error: ${e?.message} | chunks=${chunkCount} | bytes=${totalBytes} | dur=${Date.now() - t0}ms`); clearStall(); streamController.handleError(e); },
    handleDisconnect: (r) => { terminated = true; settleLifecycle("onCancel", r); dbg(tag, `disconnect: ${r} | chunks=${chunkCount} | bytes=${totalBytes} | dur=${Date.now() - t0}ms`); clearStall(); streamController.handleDisconnect(r); },
    abort: () => { terminated = true; clearStall(); streamController.abort(); }
  };

  armStall();
  dbg(tag, `pipe start | stallTimeout=${stallTimeoutMs}ms`);

  const upstreamTap = new TransformStream({
    transform(chunk, controller) {
      chunkCount++;
      const sz = chunk?.byteLength || chunk?.length || 0;
      totalBytes += sz;
      const now = Date.now();
      const gap = now - lastChunkAt;
      lastChunkAt = now;
      if (isDebugEnabled && (chunkCount <= 5 || chunkCount % 20 === 0 || gap > 5000)) {
        dbg(tag, `chunk #${chunkCount} | size=${sz}B | gap=${gap}ms | total=${totalBytes}B`);
      }
      armStall();
      controller.enqueue(chunk);
    },
    flush() { dbg(tag, `upstream EOF | chunks=${chunkCount} | bytes=${totalBytes} | dur=${Date.now() - t0}ms`); clearStall(); }
  });

  const transformedBody = providerResponse.body
    .pipeThrough(upstreamTap)
    .pipeThrough(transformStream);

  return createDisconnectAwareStream(
    { readable: transformedBody },
    wrappedController,
    onAbortTerminal,
    lifecycle
  );
}

