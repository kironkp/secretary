// The app's public origin, for every absolute URL a browser or Google is sent
// to (SEC-A011, 2026-10-06). Behind the Heroku router a request's own URL is
// the dyno's internal origin (https://localhost:$PORT): Kiron finished
// Google's consent on v55 and was redirected there, to a page that could not
// load, although the connection itself had been stored.
//
// The order: BETTER_AUTH_URL (set on Heroku, and what sign-in already uses),
// then NEXT_PUBLIC_APP_URL, then, only when neither is configured (local
// development), the request's own origin. x-forwarded-host is deliberately
// NOT trusted: it is a request header any client can set, and an origin taken
// from it would let a crafted request send the browser, or Google's
// redirect_uri, anywhere.

function configured(): string | null {
  for (const raw of [process.env.BETTER_AUTH_URL, process.env.NEXT_PUBLIC_APP_URL]) {
    if (!raw?.trim()) continue;
    try {
      return new URL(raw.trim()).origin;
    } catch {
      /* not a URL: try the next */
    }
  }
  return null;
}

/** The public origin, "https://host", with no trailing slash. */
export function publicOrigin(requestUrl: string): string {
  return configured() ?? new URL(requestUrl).origin;
}

/** An absolute URL on the public origin for `path` (with its query, if any). */
export function publicUrl(path: string, requestUrl: string): URL {
  return new URL(path, publicOrigin(requestUrl));
}
