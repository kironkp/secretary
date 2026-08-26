import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { user } from "@/lib/db/schema";
import { BrainSettings } from "@/components/settings/brain-settings";
import { CalmModeToggle } from "@/components/settings/calm-mode-toggle";
import { LayoutPreferences } from "@/components/settings/layout-preferences";
import { ProposalReview } from "@/components/settings/proposal-review";
import { SassSlider } from "@/components/settings/sass-slider";
import { VoicePicker } from "@/components/settings/voice-picker";
import { layoutPreferences } from "@/lib/db/schema";
import { PasskeySection } from "@/components/settings/passkey-section";
import { ShopRequests } from "@/components/settings/shop-requests";
import { TimezoneForm } from "@/components/settings/timezone-form";
import { SignOutButton } from "@/components/settings/sign-out-button";
import { AppearancePicker } from "@/components/shell/theme";

export default async function SettingsPage() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/sign-in");

  const timezone = (session.user as { timezone?: string }).timezone ?? "UTC";
  const [[userRow], prefRows] = await Promise.all([
    db
      .select({ calmMode: user.calmMode, persona: user.persona })
      .from(user)
      .where(eq(user.id, session.user.id)),
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
        <h2 className="mb-1 text-sm font-bold">Personality</h2>
        <p className="mb-4 text-xs text-muted">
          How much attitude your secretary has — in writing and out loud. You can
          also just tell it: &ldquo;be more sassy&rdquo;, &ldquo;tone it down&rdquo;.
        </p>
        <SassSlider initial={userRow?.persona?.sass ?? 4} />
        <h3 className="mb-1 mt-4 text-xs font-bold uppercase tracking-wide text-muted">
          Voice
        </h3>
        <p className="mb-2 text-xs text-muted">
          The voice on calls. Also switchable mid-call from the call controls.
        </p>
        <VoicePicker initial={userRow?.persona?.voice ?? "marin"} />
      </section>

      <section className="rounded-xl border border-edge bg-surface p-5">
        <h2 className="mb-1 text-sm font-bold">Brain</h2>
        <p className="mb-4 text-xs text-muted">
          The Claude model that parses your conversations into tasks, paints the
          canvas, and plans the dashboard — and how hard it thinks. The call
          voice itself is unaffected.
        </p>
        <BrainSettings
          initialModel={userRow?.persona?.brainModel ?? "claude-opus-5"}
          initialEffort={userRow?.persona?.brainEffort ?? "high"}
        />
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
        <h3 className="mb-1 mt-4 text-xs font-bold uppercase tracking-wide text-muted">
          Proposed components
        </h3>
        <ProposalReview />
      </section>

      <section className="rounded-xl border border-edge bg-surface p-5">
        <h2 className="mb-1 text-sm font-bold">The Shop</h2>
        <p className="mb-4 text-xs text-muted">
          When the secretary can&rsquo;t do something, it files the missing ability here.
          Claude Code drafts a plan; you approve; the build lands automatically once the
          full test suite passes. Every shipped change is one revert away.
        </p>
        <ShopRequests />
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
