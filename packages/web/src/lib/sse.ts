import "server-only";
import type { AgentEvent } from "@yoink/backend/web";

/**
 * Wrap a producer in a Server-Sent Events response.
 *
 * One event per line-pair (`data: {...}\n\n`), which is all the client needs -
 * we're pushing discrete JSON events, not token deltas, so there's no need for
 * event names or ids. The producer gets a synchronous `emit` and is awaited; the
 * stream closes when it resolves.
 *
 * `emit` after close is swallowed rather than thrown: a client that navigates away
 * mid-turn shouldn't surface as an unhandled error in the logs, and the backend
 * work (a draft, an automation) has already happened and is persisted regardless.
 */
export function sseResponse(producer: (emit: (event: AgentEvent) => void) => Promise<void>): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const emit = (event: AgentEvent) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          closed = true; // client went away
        }
      };
      try {
        await producer(emit);
      } finally {
        closed = true;
        try {
          controller.close();
        } catch {
          /* already closed by the client */
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // Belt and braces against any proxy that would otherwise buffer the stream
      // and defeat the whole point.
      "x-accel-buffering": "no",
    },
  });
}
