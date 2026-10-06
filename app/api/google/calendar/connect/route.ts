// Settings → "Connect Google Calendar" (or ?feature=gmail, "Connect Gmail",
// SEC-A005): off to Google's consent page for that feature's scopes, with
// offline access and the grants already given kept (lib/google/oauth.ts).
// Sign-in is untouched; the grant lives in google_connection. The feature
// rides in the state cookie, so Gmail comes back to the same registered
// callback.
import { NextResponse } from "next/server";
import { isErrorResponse, requireSession } from "@/lib/api";
import { FEATURE_SCOPES, type GoogleFeature } from "@/lib/google/connection";
import { consentUrl, newState, redirectUri, STATE_COOKIE } from "@/lib/google/oauth";
import { publicUrl } from "@/lib/public-origin";

export async function GET(req: Request) {
  const user = await requireSession();
  if (isErrorResponse(user)) return user;
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    return NextResponse.redirect(publicUrl("/settings?calendar=unavailable&gmail=unavailable", req.url));
  }
  const feature: GoogleFeature = new URL(req.url).searchParams.get("feature") === "gmail" ? "gmail" : "calendar";
  const state = newState();
  const res = NextResponse.redirect(
    consentUrl({ scopes: [...FEATURE_SCOPES[feature]], redirectUri: redirectUri(req.url), state, email: user.email })
  );
  res.cookies.set(STATE_COOKIE, `${state}.${feature}`, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/api/google",
    maxAge: 600,
  });
  return res;
}
