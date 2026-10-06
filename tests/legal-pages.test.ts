// SEC-A010: the public privacy policy and terms Google's Branding page links
// to. Public means outside the (app) group (its layout is the sign-in gate;
// there is no middleware), and never asking for a session. What they say
// must be what the app does; the browser check that they answer signed out
// is e2e/smoke.spec.ts "signed out".
import { existsSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import PrivacyPage from "@/app/privacy/page";
import TermsPage from "@/app/terms/page";
import { LIMITED_USE } from "@/lib/legal";

const saved = process.env.PUBLIC_CONTACT_EMAIL;
afterEach(() => {
  if (saved === undefined) delete process.env.PUBLIC_CONTACT_EMAIL;
  else process.env.PUBLIC_CONTACT_EMAIL = saved;
});

const text = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&#x27;|&apos;/g, "'").replace(/&amp;/g, "&");

describe("public, no sign-in", () => {
  it("both pages sit outside the signed-in group, and nothing else gates them", () => {
    for (const path of ["app/privacy/page.tsx", "app/terms/page.tsx"]) {
      expect(existsSync(path), path).toBe(true);
      const src = readFileSync(path, "utf8");
      expect(src, path).not.toMatch(/@\/lib\/auth|getSession|requireSession/);
    }
    // The (app) layout is what sends a visitor without a session to sign-in.
    expect(readFileSync("app/(app)/layout.tsx", "utf8")).toMatch(/redirect\("\/sign-in"\)/);
    // A middleware (or Next 16 proxy) would gate every path; there is none. If
    // one is added, it must let these two through.
    for (const gate of ["middleware.ts", "proxy.ts"]) {
      if (existsSync(gate)) expect(readFileSync(gate, "utf8"), gate).toMatch(/privacy/);
    }
  });

  it("no tracking: no scripts, no analytics", () => {
    for (const path of ["app/privacy/page.tsx", "app/terms/page.tsx", "components/legal/legal-page.tsx"]) {
      expect(readFileSync(path, "utf8"), path).not.toMatch(/<script|gtag|analytics|pixel/i);
    }
  });
});

describe("what the privacy policy says", () => {
  it("carries Google's Limited Use statement word for word, with its links", () => {
    const html = renderToStaticMarkup(PrivacyPage());
    expect(text(html)).toContain(
      "The use of information received from Google Workspace scopes will adhere to the Google User Data Policy, including the Limited Use requirements."
    );
    expect(html).toContain(LIMITED_USE.policy.href);
    expect(html).toContain(LIMITED_USE.limitedUse.href);
  });

  it("says what is stored, what Google data is touched, that it never sends, who processes it, and how to revoke", () => {
    const t = text(renderToStaticMarkup(PrivacyPage()));
    for (const fact of [
      "for their own use",
      "the tokens of a Google Calendar and Gmail connection, and any AI provider key you connect. These are encrypted (AES-GCM)",
      "the sign-in tokens Google issues for that (an access token and an ID token, which allow reading your basic profile) are stored with your account. These are not encrypted today.",
      "creates, changes and deletes events",
      "It never sends email",
      "Email messages are not stored in the app's database",
      "Anthropic and OpenAI",
      "not used to train AI models",
      "the stored tokens are deleted and the access is revoked at Google",
      "myaccount.google.com/permissions",
    ]) {
      expect(t, fact).toContain(fact);
    }
  });

  it("the contact is the published address when set, and never an invented one", () => {
    process.env.PUBLIC_CONTACT_EMAIL = "owner@example.com";
    expect(renderToStaticMarkup(PrivacyPage())).toContain('href="mailto:owner@example.com"');
    expect(renderToStaticMarkup(TermsPage())).toContain('href="mailto:owner@example.com"');
    delete process.env.PUBLIC_CONTACT_EMAIL;
    const unset = text(renderToStaticMarkup(PrivacyPage()));
    expect(unset).toContain("the developer contact address shown on the app's Google consent screen");
    expect(unset).not.toMatch(/mailto:/);
    process.env.PUBLIC_CONTACT_EMAIL = "not an address";
    expect(renderToStaticMarkup(PrivacyPage())).not.toContain("mailto:");
  });
});

describe("no one is named", () => {
  it("the owner is not named anywhere on either page (their choice)", () => {
    for (const html of [renderToStaticMarkup(PrivacyPage()), renderToStaticMarkup(TermsPage())]) {
      expect(text(html)).not.toMatch(/Kiron/i);
      expect(text(html)).toContain("the app's owner");
    }
    for (const path of ["app/privacy/page.tsx", "app/terms/page.tsx", "lib/legal.ts", "components/legal/legal-page.tsx"]) {
      expect(readFileSync(path, "utf8"), path).not.toMatch(/Kiron/i);
    }
  });
});

describe("what the terms say", () => {
  it("personal use, never sends email, links the privacy policy", () => {
    const html = renderToStaticMarkup(TermsPage());
    const t = text(html);
    expect(t).toContain("for their own use");
    expect(t).toContain("It never sends email");
    expect(html).toContain('href="/privacy"');
  });
});
