// Gmail, on demand (SEC-A005, 2026-10-06): what's new, a search, one message
// read, and a reply saved as a draft. It never sends: GoogleHttp has no way
// to, and a draft only ever goes back to the sender of the message it
// answers (From, not a Reply-To the mail itself could set; no Cc, no Bcc).
// Everything a message says is DATA, fenced as untrusted, and reading it
// marks the conversation so later writes there need the user's own yes
// (lib/secretary/proposals.ts). Nothing from mail is stored here.
import { GMAIL_DRAFT_SCOPE, GMAIL_READ_SCOPE, withGoogle, type GmailMessage, type GmailPart } from "./connection";

export const EMAIL_BEGIN = "----- BEGIN EMAIL CONTENT -----";
export const EMAIL_END = "----- END EMAIL CONTENT -----";
const BODY_CHARS = 4000;
const SUMMARY_MAX = 20;
const SEARCH_MAX = 10;

export type MailLine = { id: string; from: string; subject: string; date: string; snippet: string };

const header = (m: GmailMessage, name: string): string =>
  m.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";

/** Outside text inside the fence, with any copy of the end marker defused. */
export function fence(text: string): string {
  return [EMAIL_BEGIN, text.replaceAll(EMAIL_END, "----- END EMAIL CONTENT (escaped) -----"), EMAIL_END].join("\n");
}

function line(m: GmailMessage): MailLine {
  return {
    id: m.id,
    from: header(m, "From"),
    subject: header(m, "Subject"),
    date: header(m, "Date"),
    snippet: fence(m.snippet ?? ""),
  };
}

async function metadataFor(userId: string, q: string, max: number): Promise<MailLine[]> {
  return withGoogle(userId, GMAIL_READ_SCOPE, async (http, token) => {
    const ids = await http.listMessages(token, q, max);
    return Promise.all(ids.map(async ({ id }) => line(await http.getMessage(token, id, "metadata"))));
  });
}

/** The newest mail in the inbox, `since` a Gmail age like "1d" (default: the last day). */
export function inboxSummary(userId: string, since = "1d"): Promise<MailLine[]> {
  return metadataFor(userId, `in:inbox newer_than:${/^\d{1,3}[dmy]$/.test(since) ? since : "1d"}`, SUMMARY_MAX);
}

/** Mail matching a Gmail search ("from:ann boat"). */
export function searchMail(userId: string, query: string): Promise<MailLine[]> {
  return metadataFor(userId, query, SEARCH_MAX);
}

function plainText(part: GmailPart | undefined): string {
  if (!part) return "";
  if (part.mimeType === "text/plain" && part.body?.data) return Buffer.from(part.body.data, "base64url").toString("utf8");
  for (const p of part.parts ?? []) {
    const t = plainText(p);
    if (t) return t;
  }
  if (part.mimeType === "text/html" && part.body?.data) {
    return Buffer.from(part.body.data, "base64url")
      .toString("utf8")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
  return "";
}

/** One message, its text cut at 4,000 characters and fenced. */
export async function readMail(userId: string, id: string): Promise<MailLine & { body: string }> {
  return withGoogle(userId, GMAIL_READ_SCOPE, async (http, token) => {
    const m = await http.getMessage(token, id, "full");
    const text = plainText(m.payload);
    return { ...line(m), body: fence(text.length > BODY_CHARS ? `${text.slice(0, BODY_CHARS)}…` : text) };
  });
}

/** A header value with no line breaks: nothing in a mail header can add a header of ours. */
const oneLine = (v: string) => v.replace(/[\r\n]+/g, " ").trim();

/** Non-ASCII header text as an RFC 2047 encoded word. */
const encodeWord = (v: string) => (/^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v, "utf8").toString("base64")}?=`);

const ADDRESS = /^[^\s@<>",;:\\()[\]]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;

/**
 * Who a reply goes to: the first mailbox of a From header, and nobody else.
 * Commas inside a quoted name ("Lee, Ann" <ann@x.com>) don't split it; the
 * address is the one in angle brackets, a quoted name can't supply one, and
 * the name loses anything that could open a second address or header.
 * Null when there isn't one plain address to reply to.
 */
export function replyTo(from: string): { header: string; shown: string } | null {
  let quoted = false;
  let angle = false;
  let end = from.length;
  for (let i = 0; i < from.length; i++) {
    const c = from[i];
    if (c === "\\" && quoted) i++;
    else if (c === '"') quoted = !quoted;
    else if (!quoted && c === "<") angle = true;
    else if (!quoted && c === ">") angle = false;
    else if (!quoted && !angle && c === ",") {
      end = i;
      break;
    }
  }
  const first = oneLine(from.slice(0, end));
  const bracketed = /<([^<>\s]+)>$/.exec(first);
  const address = bracketed ? bracketed[1] : first;
  if (!ADDRESS.test(address)) return null;
  const name = bracketed ? first.slice(0, bracketed.index).replace(/["\\<>]/g, "").trim() : "";
  if (!name) return { header: address, shown: address };
  const quotedName = /^[\x20-\x7e]*$/.test(name) ? `"${name}"` : encodeWord(name);
  return { header: `${quotedName} <${address}>`, shown: `${name} <${address}>` };
}

/**
 * A reply to message `id`, saved as a Gmail draft and never sent. It goes to
 * the original sender only; `body` is the user's words and cannot add a
 * recipient (the headers end before it).
 */
export async function draftReply(userId: string, id: string, body: string): Promise<{ draftId: string; to: string; subject: string }> {
  return withGoogle(userId, GMAIL_DRAFT_SCOPE, async (http, token) => {
    const original = await http.getMessage(token, id, "metadata");
    const to = replyTo(header(original, "From"));
    if (!to) throw new Error("I couldn't tell who sent that email, so there's no draft.");
    const subjectIn = oneLine(header(original, "Subject"));
    const subject = /^re:/i.test(subjectIn) ? subjectIn : `Re: ${subjectIn}`;
    const messageId = oneLine(header(original, "Message-ID"));
    const references = oneLine([header(original, "References"), messageId].filter(Boolean).join(" "));
    const raw = [
      `To: ${to.header}`,
      `Subject: ${encodeWord(subject)}`,
      ...(messageId ? [`In-Reply-To: ${messageId}`, `References: ${references}`] : []),
      "Content-Type: text/plain; charset=UTF-8",
      "",
      body,
    ].join("\r\n");
    const { id: draftId } = await http.createDraft(token, Buffer.from(raw, "utf8").toString("base64url"), original.threadId);
    return { draftId, to: to.shown, subject };
  });
}
