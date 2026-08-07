import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { PasskeySection } from "@/components/settings/passkey-section";
import { TimezoneForm } from "@/components/settings/timezone-form";
import { SignOutButton } from "@/components/settings/sign-out-button";

export default async function SettingsPage() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/sign-in");

  const timezone = (session.user as { timezone?: string }).timezone ?? "UTC";

  return (
    <div className="mx-auto max-w-xl space-y-6">
      <div>
        <h1 className="text-lg font-bold">Settings</h1>
        <p className="text-sm text-muted">
          Signed in as <span className="text-ink">{session.user.email}</span>
        </p>
      </div>

      <section className="rounded-xl border border-edge bg-surface p-5">
        <h2 className="mb-1 text-sm font-bold">Timezone</h2>
        <p className="mb-4 text-xs text-muted">
          Every briefing, due date, and &ldquo;overdue&rdquo; is computed in this zone.
          It was captured from your browser at signup.
        </p>
        <TimezoneForm current={timezone} />
      </section>

      <section className="rounded-xl border border-edge bg-surface p-5">
        <h2 className="mb-1 text-sm font-bold">Passkeys</h2>
        <p className="mb-4 text-xs text-muted">
          Sign in with Face ID / Touch ID instead of a password.
        </p>
        <PasskeySection />
      </section>

      <section className="rounded-xl border border-edge bg-surface p-5">
        <h2 className="mb-1 text-sm font-bold">Coming later</h2>
        <p className="text-xs text-muted">
          Voice &amp; model picker (V1) · persona editor (V1) · 2FA (V1) · data
          export &amp; delete account (before launch).
        </p>
      </section>

      <SignOutButton />
    </div>
  );
}
