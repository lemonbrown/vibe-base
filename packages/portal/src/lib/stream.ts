import type { JobEvent } from "@vibe/shared";

/**
 * Subscribe to a conversation's latest job stream over SSE. The control-plane
 * emits `{ seq, type, data }` events and a terminal `done`.
 *
 * We manage reconnection ourselves (rather than relying on the browser's native
 * EventSource retry) because the server resumes from a `?from=<seq>` query, not
 * the `Last-Event-ID` header — so we track the highest seq seen and reopen from
 * there, which makes a dropped connection replay-free.
 *
 * Returns a disposer that permanently closes the stream.
 */
export function streamJob(
  convId: string,
  fromSeq: number,
  handlers: { onEvent: (e: JobEvent) => void; onDone?: () => void; onError?: () => void }
): () => void {
  let lastSeq = fromSeq;
  let closed = false;
  let es: EventSource | null = null;

  const open = () => {
    es = new EventSource(`/api/chat/${convId}/stream?from=${lastSeq}`);
    es.onmessage = (m) => {
      let e: JobEvent;
      try {
        e = JSON.parse(m.data);
      } catch {
        return;
      }
      if (typeof e.seq === "number") lastSeq = Math.max(lastSeq, e.seq);
      handlers.onEvent(e);
      if (e.type === "done") {
        closed = true;
        es?.close();
        handlers.onDone?.();
      }
    };
    es.onerror = () => {
      es?.close();
      if (closed) return;
      handlers.onError?.();
      // Reopen from the last seq we rendered, so we don't replay.
      window.setTimeout(() => {
        if (!closed) open();
      }, 1500);
    };
  };

  open();
  return () => {
    closed = true;
    es?.close();
  };
}
