"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { authClient } from "@/lib/auth-client";
import { Button, ErrorNote, Input, Label, SuccessNote } from "@/components/ui";
import { SocialButtons } from "./social-buttons";

export function SignInForm({ google, apple }: { google: boolean; apple: boolean }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [needsVerification, setNeedsVerification] = useState(false);
  const [busy, setBusy] = useState(false);
  // Remember me, ticked by default (SEC-A012): 60 days, renewed on use.
  const [remember, setRemember] = useState(true);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setNotice("");
    setNeedsVerification(false);
    setBusy(true);
    const { error } = await authClient.signIn.email({ email, password, rememberMe: remember });
    setBusy(false);
    if (error) {
      if (error.status === 403) {
        setNeedsVerification(true);
        setError("Your email isn't verified yet — check your inbox.");
      } else {
        setError(error.message ?? "Sign-in failed. Try again.");
      }
      return;
    }
    router.push("/chat");
    router.refresh();
  };

  const signInWithPasskey = async () => {
    setError("");
    const res = await authClient.signIn.passkey();
    if (res?.error) {
      setError(res.error.message ?? "Passkey sign-in failed.");
      return;
    }
    router.push("/chat");
    router.refresh();
  };

  const resendVerification = async () => {
    await authClient.sendVerificationEmail({ email, callbackURL: "/chat" });
    setNotice(`Verification email re-sent to ${email}.`);
  };

  return (
    <div>
      <h1 className="mb-1 text-lg font-bold">Welcome back</h1>
      <p className="mb-6 text-sm text-muted">Your secretary has been keeping notes.</p>
      <SocialButtons google={google} apple={apple} />
      <form onSubmit={onSubmit} className="space-y-4">
        <div>
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            autoComplete="email webauthn"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
          />
        </div>
        <div>
          <div className="flex items-baseline justify-between">
            <Label htmlFor="password">Password</Label>
            <Link href="/forgot-password" className="text-xs text-accent hover:underline">
              Forgot?
            </Link>
          </div>
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        <div>
          <label htmlFor="remember" className="flex min-h-11 cursor-pointer items-center gap-2.5 text-sm">
            <input
              id="remember"
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
              className="h-5 w-5 flex-none accent-[var(--color-accent)]"
            />
            Remember me
          </label>
          <p className="text-xs text-faint">
            {remember
              ? "Stay signed in on this device for 60 days, renewed each time you use it."
              : "You'll be signed out when you close the browser or the app."}{" "}
            Google and passkey sign-in always keep you signed in.
          </p>
        </div>
        <ErrorNote>{error}</ErrorNote>
        <SuccessNote>{notice}</SuccessNote>
        {needsVerification && (
          <Button type="button" variant="secondary" className="w-full" onClick={resendVerification}>
            Resend verification email
          </Button>
        )}
        <Button type="submit" disabled={busy} className="w-full">
          {busy ? "Signing in…" : "Sign in"}
        </Button>
      </form>
      <Button
        type="button"
        variant="secondary"
        className="mt-3 w-full"
        onClick={signInWithPasskey}
      >
        Sign in with a passkey
      </Button>
      <p className="mt-5 text-center text-xs text-muted">
        New here?{" "}
        <Link href="/sign-up" className="text-accent hover:underline">
          Create an account
        </Link>
      </p>
    </div>
  );
}
