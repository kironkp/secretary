"use client";

import Link from "next/link";
import { useState } from "react";
import { authClient } from "@/lib/auth-client";
import { Button, ErrorNote, Input, Label, SuccessNote } from "@/components/ui";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    const { error } = await authClient.requestPasswordReset({
      email,
      redirectTo: "/reset-password",
    });
    setBusy(false);
    if (error) setError(error.message ?? "Something went wrong. Try again.");
    else setSent(true);
  };

  return (
    <div>
      <h1 className="mb-1 text-lg font-bold">Reset your password</h1>
      <p className="mb-6 text-sm text-muted">
        We&apos;ll email you a single-use link. It expires quickly.
      </p>
      <form onSubmit={onSubmit} className="space-y-4">
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
        <ErrorNote>{error}</ErrorNote>
        <SuccessNote>
          {sent ? `If an account exists for ${email}, a reset link is on its way.` : ""}
        </SuccessNote>
        <Button type="submit" disabled={busy || sent} className="w-full">
          {busy ? "Sending…" : "Send reset link"}
        </Button>
      </form>
      <p className="mt-5 text-center text-xs text-muted">
        <Link href="/sign-in" className="text-accent hover:underline">
          Back to sign in
        </Link>
      </p>
    </div>
  );
}
