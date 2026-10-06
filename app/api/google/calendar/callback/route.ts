// Google's redirect after consent: check the state, trade the code for
// tokens, store them encrypted (lib/google/connection.ts saveConnection) and
// go back to Settings saying how it went. Nothing here prints a token: a
// failure logs Google's error code only.
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { isErrorResponse, requireSession } from "@/lib/api";
import { FEATURE_SCOPES, googleHttp, saveConnection, type GoogleFeature } from "@/lib/google/connection";
import { redirectUri, sameState, STATE_COOKIE } from "@/lib/google/oauth";

function back(req: Request, outcome: string, feature: GoogleFeature = "calendar"): NextResponse {
  const res = NextResponse.redirect(new URL(`/settings?${feature}=${outcome}`, req.url));
  res.cookies.set(STATE_COOKIE, "", { path: "/api/google", maxAge: 0 });
  return res;
}

export async function GET(req: Request) {
  const user = await requireSession();
  if (isErrorResponse(user)) return user;
  const params = new URL(req.url).searchParams;
  const jar = await cookies();
  // The cookie is "<state>.<feature>": which button started this.
  const [issued, which] = (jar.get(STATE_COOKIE)?.value ?? "").split(".");
  const feature: GoogleFeature = which === "gmail" ? "gmail" : "calendar";
  if (!sameState(params.get("state"), issued)) return back(req, "failed", feature);
  if (params.get("error")) return back(req, "denied", feature);
  const code = params.get("code");
  if (!code) return back(req, "failed", feature);

  try {
    const tokens = await googleHttp().exchangeCode(code, redirectUri(req.url));
    // Google's granular consent lets the user untick a box: every scope the
    // feature needs must have been granted.
    const granted = tokens.scope?.split(" ") ?? [];
    if (!FEATURE_SCOPES[feature].every((s) => granted.includes(s))) return back(req, "scope-missing", feature);
    await saveConnection(user.id, tokens);
  } catch (e) {
    console.error("google: connect failed:", e instanceof Error ? e.message : String(e));
    return back(req, "failed", feature);
  }
  return back(req, "connected", feature);
}
