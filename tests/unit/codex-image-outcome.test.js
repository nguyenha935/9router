import { describe, expect, it, vi } from "vitest";
import codexImage from "../../open-sse/handlers/imageProviders/codex.js";

const encoder = new TextEncoder();

function sseResponse(events) {
  const text = events.map(({ event, data }) =>
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  ).join("");
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  }), { headers: { "Content-Type": "text/event-stream" } });
}

async function readText(response) {
  return new TextDecoder().decode(await response.arrayBuffer());
}

describe("Codex image stream outcome", () => {
  it("rejects a failure terminal before image evidence", async () => {
    const parsed = await codexImage.parseResponse(sseResponse([
      {
        event: "response.failed",
        data: { response: { status: "failed", error: { message: "image quota" } } },
      },
    ]), { streamToClient: true, onRequestSuccess: vi.fn() });

    await expect(parsed.precommit).resolves.toMatchObject({
      ok: false,
      errorKind: "upstream_payload_error",
      message: "image quota",
    });
  });

  it("commits on a partial image but does not clear success after a late failure", async () => {
    const onRequestSuccess = vi.fn();
    const parsed = await codexImage.parseResponse(sseResponse([
      {
        event: "response.image_generation_call.partial_image",
        data: { partial_image_b64: "AQID", partial_image_index: 0 },
      },
      {
        event: "response.failed",
        data: { response: { status: "failed", error: { message: "render failed" } } },
      },
    ]), { streamToClient: true, onRequestSuccess });

    await expect(parsed.precommit).resolves.toEqual({ ok: true });
    const output = await readText(parsed.sseResponse);
    expect(output).toContain("event: partial_image");
    expect(output).toContain("event: error");
    expect(onRequestSuccess).not.toHaveBeenCalled();
  });

  it("marks success only after a completed stream with a final image", async () => {
    const onRequestSuccess = vi.fn();
    const parsed = await codexImage.parseResponse(sseResponse([
      {
        event: "response.output_item.done",
        data: { item: { type: "image_generation_call", result: "AQID" } },
      },
      {
        event: "response.completed",
        data: { response: { status: "completed" } },
      },
    ]), { streamToClient: true, onRequestSuccess });

    await expect(parsed.precommit).resolves.toEqual({ ok: true });
    const output = await readText(parsed.sseResponse);
    expect(output).toContain("event: done");
    expect(onRequestSuccess).toHaveBeenCalledTimes(1);
  });
});
