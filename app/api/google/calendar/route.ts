// Settings' Google Calendar row: is it connected, and Disconnect. The status
// carries no token, only the state and when it was connected.
import { NextResponse } from "next/server";
import { isErrorResponse, requireSession } from "@/lib/api";
import { connectionStatus, disconnectGoogle } from "@/lib/google/connection";

export async function GET() {
  const user = await requireSession();
  if (isErrorResponse(user)) return user;
  return NextResponse.json(await connectionStatus(user.id));
}

export async function DELETE() {
  const user = await requireSession();
  if (isErrorResponse(user)) return user;
  await disconnectGoogle(user.id);
  return NextResponse.json({ state: "not-connected" });
}
