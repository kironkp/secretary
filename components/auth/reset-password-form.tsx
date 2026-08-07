"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { authClient } from "@/lib/auth-client";
import { Button, ErrorNote, Input, Label } from "@/components/ui";

export function ResetPasswordForm({
  token,
  tokenError,
}: {
  token?: string;
  tokenError?: string;
}) {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  if (tokenError || !token) {
    return (
      <div className="space-y-3 text-center">
        <h1 className="text-lg font-bold">Link expired</h1>
        <p className="text-sm text-muted">
          That reset link is invalid or has already been used.
        </p>
        <Link href="/forgot-password" className="text-sm text-accent hover:underline">
          Request a new one
        </Link>
      </div>
    );
  }

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    const { error } = await authClient.resetPassword({ newPassword: password, token });
    setBusy(false);
    if (error) {
      setError(error.message ?? "Reset failed — the link may have expired.");
      return;
    }
    router.push("/sign-in");
  };

  return (
    <div>
      <h1 className="mb-1 text-lg font-bold">Choose a new password</h1>
      <p className="mb-6 text-sm text-muted">Then sign back in with it.</p>
      <form onSubmit={onSubmit} className="space-y-4">
        <div>
          <Label htmlFor="password">New password</Label>
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
          {busy ? "Saving…" : "Set password"}
        </Button>
      </form>
    </div>
  );
}
