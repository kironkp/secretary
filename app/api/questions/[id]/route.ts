// GET /api/questions/[id] — one question with its evidence resolved
// (docs/understanding/SPEC.md §9, "a question, opened"). Any status: a
// resolved question still shows what it rested on and what was answered.
import { NextResponse } from "next/server";
import { isErrorResponse, requireSession } from "@/lib/api";
import { getQuestion } from "@/lib/understanding/questions";
import { viewQuestion } from "@/lib/understanding/today";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireSession();
  if (isErrorResponse(user)) return user;
  const { id } = await params;

  const row = await getQuestion(user.id, id);
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(await viewQuestion(user.id, row, user.timezone));
}
