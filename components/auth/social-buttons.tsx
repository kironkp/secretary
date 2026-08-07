"use client";

import { useState } from "react";
import { authClient } from "@/lib/auth-client";
import { Button, ErrorNote } from "@/components/ui";

// Rendered only for providers whose env keys exist (dormant otherwise).
export function SocialButtons({ google, apple }: { google: boolean; apple: boolean }) {
  const [error, setError] = useState("");
  if (!google && !apple) return null;

  const signIn = async (provider: "google" | "apple") => {
    setError("");
    const { error } = await authClient.signIn.social({
      provider,
      callbackURL: "/chat",
    });
    if (error) setError(error.message ?? "Sign-in failed. Try again.");
  };

  return (
    <div className="space-y-2">
      {google && (
        <Button
          type="button"
          variant="secondary"
          className="w-full"
          onClick={() => signIn("google")}
        >
          Continue with Google
        </Button>
      )}
      {apple && (
        <Button
          type="button"
          variant="secondary"
          className="w-full"
          onClick={() => signIn("apple")}
        >
          Continue with Apple
        </Button>
      )}
      <ErrorNote>{error}</ErrorNote>
      <div className="flex items-center gap-3 py-2">
        <div className="h-px flex-1 bg-edge" />
        <span className="text-[11px] text-faint">or</span>
        <div className="h-px flex-1 bg-edge" />
      </div>
    </div>
  );
}
