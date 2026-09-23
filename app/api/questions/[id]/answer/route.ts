// POST /api/questions/[id]/answer — docs/understanding/SPEC.md §6.
//
// Two ways to answer, one of them per request: `answerId` picks a listed
// answer (a tapped pill), `text` answers in the user's own words ("Write
// your own"), which one small model call reads against the question. The
// writes happen inside lib/understanding/answer.ts, through the existing
// tools. The project's re-run (§6 step 4) is scheduled with after(): the
// response carries the writes that succeeded and never waits on a model.
import { NextResponse, after } from "next/server";
import { z } from "zod";
import { badRequest, isErrorResponse, parseBody, requireSession } from "@/lib/api";
import {
  ANSWER_SOURCES,
  MAX_OWN_WORDS,
  answerInOwnWords,
  answerQuestion,
  rerunAfterAnswer,
  type AnswerResult,
} from "@/lib/understanding/answer";
import { InterpretError } from "@/lib/understanding/interpret";

const bodySchema = z.object({
  answerId: z.string().min(1).max(40).optional(),
  // One cap with `text`: on the opened question and the Interview the same
  // field is the note and the words, so the two limits have to agree.
  note: z.string().max(MAX_OWN_WORDS).optional(),
  /** The user's own words, instead of a listed answer. */
  text: z.string().min(1).max(MAX_OWN_WORDS).optional(),
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
  // Exactly one: a pill or the field, never both, never neither.
  if ((parsed.answerId === undefined) === (parsed.text === undefined)) {
    return badRequest("Give exactly one of answerId or text");
  }

  let result: AnswerResult;
  if (parsed.text !== undefined) {
    try {
      result = await answerInOwnWords(user.id, user.timezone, id, parsed.text, parsed.source);
    } catch (e) {
      // No model, a model error, or output that was not an interpretation:
      // nothing was written, and the honest answer is why, not 500. The
      // error's message is the user's line (the provider's when reading is
      // paused, else "Could not read that right now."); the field keeps the
      // text. What actually happened goes to the log.
      if (!(e instanceof InterpretError)) throw e;
      console.error(
        `understanding: could not read an answer in the user's words: ${e.message}${e.detail ? ` (${e.detail})` : ""}`
      );
      return NextResponse.json({ error: e.message }, { status: 503 });
    }
  } else {
    result = await answerQuestion(
      user.id,
      user.timezone,
      id,
      parsed.answerId as string,
      parsed.note,
      parsed.source
    );
  }

  if (result.status === "resolved" && result.projectId) {
    const projectId = result.projectId;
    after(() => rerunAfterAnswer(user.id, projectId, user.timezone));
  }
  return NextResponse.json(result, { status: STATUS[result.status] });
}
