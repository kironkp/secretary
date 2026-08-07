"use client";

import Link from "next/link";
import { useState } from "react";
import { authClient } from "@/lib/auth-client";
import { Button, ErrorNote, Input, Label } from "@/components/ui";
import { SocialButtons } from "./social-buttons";

export function SignUpForm({ google, apple }: { google: boolean; apple: boolean }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    // Timezone capture is load-bearing: every briefing and due-date computation
    // runs in this zone. Stored on the user record; editable in settings.
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const { error } = await authClient.signUp.email({
      name,
      email,
      password,
      timezone,
      callbackURL: "/chat",
    });
    setBusy(false);
    if (error) setError(error.message ?? "Sign-up failed. Try again.");
    else setSent(true);
  };

  if (sent) {
    return (
      <div className="space-y-3 text-center">
        <h1 className="text-lg font-bold">Check your email</h1>
        <p className="text-sm text-muted">
          We sent a verification link to <span className="text-ink">{email}</span>.
          Click it and your secretary gets to work.
        </p>
        <p className="text-xs text-faint">
          Nothing arriving? Check spam, or{" "}
          <button
            className="text-accent hover:underline"
            onClick={() =>
              authClient.sendVerificationEmail({ email, callbackURL: "/chat" })
            }
          >
            resend it
          </button>
          .
        </p>
      </div>
    );
  }

  return (
    <div>
      <h1 className="mb-1 text-lg font-bold">Create your account</h1>
      <p className="mb-6 text-sm text-muted">Your adulting life, handled.</p>
      <SocialButtons google={google} apple={apple} />
      <form onSubmit={onSubmit} className="space-y-4">
        <div>
          <Label htmlFor="name">Name</Label>
          <Input
            id="name"
            autoComplete="name"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="What should I call you?"
          />
        </div>
        <div>
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
          />
        </div>
        <div>
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            type="password"
            autoComplete="new-password"
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="At least 8 characters"
          />
        </div>
        <ErrorNote>{error}</ErrorNote>
        <Button type="submit" disabled={busy} className="w-full">
          {busy ? "Creating account…" : "Sign up"}
        </Button>
      </form>
      <p className="mt-5 text-center text-xs text-muted">
        Already have an account?{" "}
        <Link href="/sign-in" className="text-accent hover:underline">
          Sign in
        </Link>
      </p>
    </div>
  );
}
