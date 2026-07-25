"use client";

import { useCallback, useRef, useState } from "react";

export type AgentEvent =
  | { type: "stage"; label: string }
  | { type: "message"; text: string }
  | { type: "result"; data?: unknown }
  | { type: "error"; message: string };

export interface Activity {
  label: string;
  /** False once a later stage has started — renders as a completed tick. */
  active: boolean;
}

/**
 * Consume one of the SSE agent endpoints.
 *
 * `EventSource` can't POST, so this reads the response body directly and splits
 * on the SSE record separator. Events are discrete JSON objects (not token
 * deltas), so a partial-line buffer is all the framing we need.
 *
 * The activity list is append-only and keeps completed steps visible — seeing
 * "Retrieving relevant memories ✓ → Reading what's actually worked for you" is
 * the point; a single replaced line would just be a fancier spinner.
 */
export function useAgentStream() {
  const [activity, setActivity] = useState<Activity[]>([]);
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const reset = useCallback(() => setActivity([]), []);

  const run = useCallback(
    async (
      url: string,
      body: unknown,
      handlers: {
        onMessage?: (text: string) => void;
        onResult?: (data: unknown) => void;
        onError?: (message: string, status?: number) => void;
      } = {},
    ) => {
      setBusy(true);
      setActivity([]);
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        // Pre-stream rejections (401/402/400) still come back as plain JSON.
        if (!res.ok || !res.body) {
          const data = await res.json().catch(() => ({}) as { error?: string });
          handlers.onError?.(data.error ?? "Something went wrong.", res.status);
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          const records = buffer.split("\n\n");
          buffer = records.pop() ?? ""; // trailing partial record
          for (const record of records) {
            const line = record.split("\n").find((l) => l.startsWith("data: "));
            if (!line) continue;
            let event: AgentEvent;
            try {
              event = JSON.parse(line.slice(6)) as AgentEvent;
            } catch {
              continue; // never let one malformed record kill the turn
            }
            if (event.type === "stage") {
              // Mark everything before it done, append the new one as active.
              setActivity((prev) => [...prev.map((a) => ({ ...a, active: false })), { label: event.label, active: true }]);
            } else if (event.type === "message") {
              handlers.onMessage?.(event.text);
            } else if (event.type === "result") {
              setActivity((prev) => prev.map((a) => ({ ...a, active: false })));
              handlers.onResult?.(event.data);
            } else if (event.type === "error") {
              setActivity((prev) => prev.map((a) => ({ ...a, active: false })));
              handlers.onError?.(event.message);
            }
          }
        }
      } catch (err) {
        if ((err as Error)?.name !== "AbortError") handlers.onError?.("Network dropped — try again.");
      } finally {
        setBusy(false);
        abortRef.current = null;
      }
    },
    [],
  );

  const stop = useCallback(() => abortRef.current?.abort(), []);

  return { run, stop, reset, activity, busy };
}
