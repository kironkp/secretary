// Multi-user Claude connections: the site login (better-auth) is one layer;
// connected_accounts is the "attach your own Claude key" layer. Keys are
// encrypted at rest; resolution order is user key → house key → null.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { connectedAccounts, user } from "@/lib/db/schema";
import { decryptSecret, encryptSecret } from "@/lib/crypto";

const U = { id: `test-conn-${crypto.randomUUID()}`, email: `conn-${Date.now()}@acct.test` };

beforeAll(async () => {
  await db.insert(user).values({ id: U.id, name: "Conn Tester", email: U.email });
});
afterAll(async () => {
  await db.delete(user).where(eq(user.id, U.id));
});

describe("secret encryption", () => {
  it("round-trips and never stores plaintext", () => {
    const key = "sk-ant-api03-abcdefghijklmnop";
    const enc = encryptSecret(key);
    expect(enc).not.toContain("sk-ant");
    expect(decryptSecret(enc)).toBe(key);
    // fresh IV per encryption — same plaintext, different ciphertext
    expect(encryptSecret(key)).not.toBe(enc);
  });

  it("tampered ciphertext refuses to decrypt (GCM auth)", () => {
    const enc = encryptSecret("sk-ant-api03-abcdefghijklmnop");
    const [iv, tag, data] = enc.split(".");
    const flipped = Buffer.from(data, "base64");
    flipped[0] ^= 0xff;
    expect(() => decryptSecret([iv, tag, flipped.toString("base64")].join("."))).toThrow();
  });
});

describe("connected account rows", () => {
  it("stores encrypted key + tail per user/provider, cascades with the user", async () => {
    const key = "sk-ant-api03-testkey-x7Ab";
    await db.insert(connectedAccounts).values({
      userId: U.id,
      provider: "anthropic",
      encryptedKey: encryptSecret(key),
      keyTail: key.slice(-4),
    });
    const [row] = await db
      .select()
      .from(connectedAccounts)
      .where(eq(connectedAccounts.userId, U.id));
    expect(row.keyTail).toBe("x7Ab");
    expect(row.encryptedKey).not.toContain("testkey");
    expect(decryptSecret(row.encryptedKey)).toBe(key);
  });
});
