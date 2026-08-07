import "server-only";
import { CapReachedError, WorkspaceAccessError } from "@yoink/backend/web";
import { capReachedResponse } from "./entitlements";

function isCapReached(error: unknown): error is CapReachedError | { code: "cap_reached"; cap?: string; message?: string } {
  return (
    error instanceof CapReachedError ||
    (!!error && typeof error === "object" && (error as { code?: unknown }).code === "cap_reached")
  );
}

/** Map domain errors to stable JSON API responses. */
export function jsonError(err: unknown, fallback = "request failed"): Response {
  if (isCapReached(err)) {
    return capReachedResponse(
      (err as { cap?: string }).cap ?? "plan",
      err instanceof Error ? err.message : "Cap reached",
    );
  }
  if (err instanceof WorkspaceAccessError) {
    return Response.json({ error: err.message, code: err.code }, { status: 403 });
  }
  if (err instanceof Error) {
    return Response.json({ error: err.message }, { status: 400 });
  }
  console.error(fallback, err);
  return Response.json({ error: fallback }, { status: 500 });
}
