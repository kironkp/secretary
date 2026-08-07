// Route helpers: session guard + consistent JSON errors (no stack traces).
import { headers } from "next/headers";
import { NextResponse } from "next/server";
import type { ZodType } from "zod";
import { auth } from "@/lib/auth";

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  timezone: string;
};

export async function requireSession(): Promise<SessionUser | NextResponse> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  const u = session.user as SessionUser & { timezone?: string };
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    timezone: u.timezone ?? "UTC",
  };
}

export function isErrorResponse(x: unknown): x is NextResponse {
  return x instanceof NextResponse;
}

export function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

export function parseBody<T>(schema: ZodType<T>, body: unknown): T | NextResponse {
  const result = schema.safeParse(body);
  if (!result.success) {
    return badRequest(result.error.issues.map((i) => i.message).join("; "));
  }
  return result.data;
}
