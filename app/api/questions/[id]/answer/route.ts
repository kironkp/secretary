// POST /api/questions/[id]/answer — docs/understanding/SPEC.md §6.
//
// The writes happen inside answerQuestion, through the existing tools. The
// project's re-run (§6 step 4) is scheduled with after(): the response
// carries the writes that succeeded and never waits on a model.
import { NextResponse, after } from "next/server";
import { z } from "zod";
import { isErrorResponse, parseBody, requireSession } from "@/lib/api";
import {
  ANSWER_SOURCES,
  answerQuestion,
  rerunAfterAnswer,
  type AnswerResult,
} from "@/lib/understanding/answer";

const bodySchema = z.object({
  answerId: z.string().min(1).max(40),
  note: z.string().max(500).optional(),
  /** Which screen is answering; a note kept as a memory is tagged with it. */
  source: z.enum(ANSWER_SOURCES).optional(),
});

const STATUS: Record<AnswerResult["status"], number> = {
  resolved: 200,
  "bad-answer": 400,
  "not-found": 404,
  "not-open": 409,
};

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireSession();
  if (isErrorResponse(user)) return user;
  const { id } = await params;

  const parsed = parseBody(bodySchema, await req.json().catch(() => ({})));
  if (isErrorResponse(parsed)) return parsed;

  const result = await answerQuestion(user.id, user.timezone, id, parsed.answerId, parsed.note, parsed.source);
  if (result.status === "resolved" && result.projectId) {
    const projectId = result.projectId;
    after(() => rerunAfterAnswer(user.id, projectId, user.timezone));
  }
  return NextResponse.json(result, { status: STATUS[result.status] });
}
