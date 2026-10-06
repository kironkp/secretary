// Settings → "Connect Google Calendar": off to Google's consent page for the
// one Calendar scope, with offline access (lib/google/oauth.ts). Sign-in is
// untouched; this grant lives in google_connection.
import { NextResponse } from "next/server";
import { isErrorResponse, requireSession } from "@/lib/api";
import { CALENDAR_SCOPE } from "@/lib/google/connection";
import { consentUrl, newState, redirectUri, STATE_COOKIE } from "@/lib/google/oauth";

export async function GET(req: Request) {
  const user = await requireSession();
  if (isErrorResponse(user)) return user;
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    return NextResponse.redirect(new URL("/settings?calendar=unavailable", req.url));
  }
  const state = newState();
  const res = NextResponse.redirect(
    consentUrl({ scopes: [CALENDAR_SCOPE], redirectUri: redirectUri(req.url), state, email: user.email })
  );
  res.cookies.set(STATE_COOKIE, state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/api/google",
    maxAge: 600,
  });
  return res;
}
