import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { user } from "@/lib/db/schema";
import { CalmModeToggle } from "@/components/settings/calm-mode-toggle";
import { LayoutPreferences } from "@/components/settings/layout-preferences";
import { layoutPreferences } from "@/lib/db/schema";
import { PasskeySection } from "@/components/settings/passkey-section";
import { TimezoneForm } from "@/components/settings/timezone-form";
import { SignOutButton } from "@/components/settings/sign-out-button";
import { AppearancePicker } from "@/components/shell/theme";

export default async function SettingsPage() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/sign-in");

  const timezone = (session.user as { timezone?: string }).timezone ?? "UTC";
  const [[userRow], prefRows] = await Promise.all([
    db.select({ calmMode: user.calmMode }).from(user).where(eq(user.id, session.user.id)),
    db
      .select({ id: layoutPreferences.id, kind: layoutPreferences.kind, value: layoutPreferences.value })
      .from(layoutPreferences)
      .where(eq(layoutPreferences.userId, session.user.id)),
  ]);

  return (
    <div className="mx-auto max-w-xl space-y-6 py-6">
      <div>
        <h1 className="text-lg font-bold">Settings</h1>
        <p className="text-sm text-muted">
          Signed in as <span className="text-ink">{session.user.email}</span>
        </p>
      </div>

      <section className="rounded-xl border border-edge bg-surface p-5">
        <h2 className="mb-1 text-sm font-bold">Appearance</h2>
        <p className="mb-4 text-xs text-muted">Light is the default; dark is one tap away.</p>
        <AppearancePicker />
      </section>

      <section className="rounded-xl border border-edge bg-surface p-5">
        <h2 className="mb-1 text-sm font-bold">Timezone</h2>
        <p className="mb-4 text-xs text-muted">
          Every briefing, due date, and &ldquo;overdue&rdquo; is computed in this zone.
          It was captured from your browser at signup.
        </p>
        <TimezoneForm current={timezone} />
      </section>

      <section className="rounded-xl border border-edge bg-surface p-5">
        <h2 className="mb-1 text-sm font-bold">Dashboard</h2>
        <p className="mb-4 text-xs text-muted">
          Calm mode freezes the dashboard in its default arrangement — the
          secretary stops rearranging until you switch it back.
        </p>
        <CalmModeToggle initial={userRow?.calmMode ?? false} />
        <h3 className="mb-1 mt-4 text-xs font-bold uppercase tracking-wide text-muted">
          Layout preferences
        </h3>
        <LayoutPreferences initial={prefRows} />
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
