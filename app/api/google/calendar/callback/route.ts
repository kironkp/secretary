// Google's redirect after consent: check the state, trade the code for
// tokens, store them encrypted (lib/google/connection.ts saveConnection) and
// go back to Settings saying how it went. Nothing here prints a token: a
// failure logs Google's error code only.
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { isErrorResponse, requireSession } from "@/lib/api";
import { CALENDAR_SCOPE, googleHttp, saveConnection } from "@/lib/google/connection";
import { redirectUri, sameState, STATE_COOKIE } from "@/lib/google/oauth";

function back(req: Request, outcome: string): NextResponse {
  const res = NextResponse.redirect(new URL(`/settings?calendar=${outcome}`, req.url));
  res.cookies.set(STATE_COOKIE, "", { path: "/api/google", maxAge: 0 });
  return res;
}

export async function GET(req: Request) {
  const user = await requireSession();
  if (isErrorResponse(user)) return user;
  const params = new URL(req.url).searchParams;
  const jar = await cookies();
  if (!sameState(params.get("state"), jar.get(STATE_COOKIE)?.value)) return back(req, "failed");
  if (params.get("error")) return back(req, "denied");
  const code = params.get("code");
  if (!code) return back(req, "failed");

  try {
    const tokens = await googleHttp().exchangeCode(code, redirectUri(req.url));
    // Google's granular consent lets the user untick the calendar box.
    if (!tokens.scope?.split(" ").includes(CALENDAR_SCOPE)) return back(req, "scope-missing");
    await saveConnection(user.id, tokens);
  } catch (e) {
    console.error("google: connect failed:", e instanceof Error ? e.message : String(e));
    return back(req, "failed");
  }
  return back(req, "connected");
}
