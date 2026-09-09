// A canvas operation just started or finished — tell the Canvas view to reload
// NOW instead of waiting out its idle poll.
//
// Why this exists: the Canvas polls every 15s when it thinks nothing is
// happening, and tightens to 1s only once it has SEEN painting:true. So the
// window between "the model called paint/edit" and "the shell notices" was up
// to a full 15 seconds of a screen that looked frozen. The auto-open path
// (router.push("/canvas")) is a no-op when the user is already on the Canvas
// tab, which is exactly when they are watching.

export const CANVAS_REFRESH_EVENT = "secretary:canvas-refresh";

/** Fire-and-forget; safe to call from anywhere on the client. */
export function requestCanvasRefresh(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(CANVAS_REFRESH_EVENT));
}
