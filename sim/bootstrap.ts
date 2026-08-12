// Sim users: direct DB seed (email pre-verified + credential account row),
// then a real HTTP sign-in to get the session cookie the API routes expect.
// Teardown = delete the user row; FK cascade wipes all domain data.
import { randomUUID } from "node:crypto";
import { eq, like } from "drizzle-orm";
import { hashPassword } from "better-auth/crypto";
import { cfg } from "./config";
import { schema, simDb } from "./db";

const PASSWORD = "sim-password-1";
export const SIM_EMAIL_SUFFIX = "@sim.local";

export type SimUser = { userId: string; email: string; cookie: string };

export async function createSimUser(opts: {
  runId: string;
  personaId: string;
  name: string;
  timezone: string;
}): Promise<SimUser> {
  const userId = `sim-${opts.runId}-${opts.personaId}`.slice(0, 120);
  const email = `${opts.personaId}-${opts.runId}${SIM_EMAIL_SUFFIX}`.toLowerCase();

  await simDb.insert(schema.user).values({
    id: userId,
    name: opts.name,
    email,
    emailVerified: true,
    timezone: opts.timezone,
  });
  await simDb.insert(schema.account).values({
    id: randomUUID(),
    accountId: userId,
    providerId: "credential",
    userId,
    password: await hashPassword(PASSWORD),
  });

  const res = await fetch(`${cfg.appUrl}/api/auth/sign-in/email`, {
    method: "POST",
    // Origin must equal the instance's baseURL — this Better Auth version
    // rejects Origin-less requests outright.
    headers: { "Content-Type": "application/json", Origin: cfg.appUrl },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  if (!res.ok) {
    throw new Error(`sign-in failed for ${email}: ${res.status} ${await res.text()}`);
  }
  const setCookie = res.headers.get("set-cookie") ?? "";
  const match = setCookie.match(/better-auth\.session_token=([^;]+)/);
  if (!match) throw new Error(`no session cookie in sign-in response for ${email}`);
  return { userId, email, cookie: `better-auth.session_token=${match[1]}` };
}

export async function deleteSimUser(userId: string): Promise<void> {
  await simDb.delete(schema.user).where(eq(schema.user.id, userId));
}

/** Wipe every sim-created user (crashed prior runs included). */
export async function wipeAllSimUsers(): Promise<number> {
  const rows = await simDb
    .delete(schema.user)
    .where(like(schema.user.email, `%${SIM_EMAIL_SUFFIX}`))
    .returning({ id: schema.user.id });
  return rows.length;
}

/** The canary: a user whose data must never change during other users' runs. */
export async function createCanaryUser(runId: string): Promise<SimUser & { conversationId: string }> {
  const canary = await createSimUser({
    runId,
    personaId: "canary",
    name: "Canary",
    timezone: "UTC",
  });
  const [project] = await simDb
    .insert(schema.projects)
    .values({ userId: canary.userId, name: "Canary Project" })
    .returning();
  await simDb.insert(schema.tasks).values([
    { userId: canary.userId, title: "Canary task alpha", status: "todo", projectId: project.id },
    {
      userId: canary.userId,
      title: "Canary task beta",
      status: "todo",
      dueAt: new Date(Date.now() + 3 * 86400000),
    },
  ]);
  await simDb.insert(schema.events).values({
    userId: canary.userId,
    title: "Canary standup",
    startsAt: new Date(Date.now() + 2 * 86400000),
  });
  await simDb
    .insert(schema.memories)
    .values({ userId: canary.userId, fact: "The canary's favorite color is yellow" });
  const [conv] = await simDb
    .insert(schema.conversations)
    .values({ userId: canary.userId, mode: "text" })
    .returning();
  await simDb.insert(schema.messages).values({
    userId: canary.userId,
    conversationId: conv.id,
    role: "user",
    content: "Canary confidential message",
    mode: "text",
  });
  return { ...canary, conversationId: conv.id };
}
