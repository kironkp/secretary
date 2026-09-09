import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { user } from "@/lib/db/schema";
import { BrainSettings } from "@/components/settings/brain-settings";
import { SpendSummary } from "@/components/settings/spend-summary";
import { spendAllTime, spendReport, spendWindow } from "@/lib/spend";
import { CalmModeToggle } from "@/components/settings/calm-mode-toggle";
import { ConnectedAccounts } from "@/components/settings/connected-accounts";
import { NotificationsSection } from "@/components/settings/notifications";
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
  const [[userRow], prefRows, spend, allTime] = await Promise.all([
    db
      .select({ calmMode: user.calmMode, persona: user.persona })
      .from(user)
      .where(eq(user.id, session.user.id)),
    db
      .select({ id: layoutPreferences.id, kind: layoutPreferences.kind, value: layoutPreferences.value })
      .from(layoutPreferences)
      .where(eq(layoutPreferences.userId, session.user.id)),
    spendReport(session.user.id, spendWindow("month", 0, timezone), timezone),
    spendAllTime(session.user.id),
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
        <h2 className="mb-1 text-sm font-bold">Email intake</h2>
        {process.env.INBOUND_EMAIL_HOST &&
        process.env.INBOUND_EMAIL_USER &&
        process.env.INBOUND_EMAIL_PASSWORD ? (
          <>
            <p className="mb-3 text-xs text-muted">
              Forward anything here <span className="font-semibold">from your login email
              address</span> ({session.user.email}) — bills, flyers, meeting threads, photos.
              The secretary reads it within a minute, files what it finds, and pings your phone
              with the receipt. Mail from unregistered senders is ignored.
            </p>
            <p className="select-all rounded-lg border border-edge bg-card px-3 py-2 font-mono text-sm">
              {process.env.INBOUND_EMAIL_ADDRESS ?? process.env.INBOUND_EMAIL_USER}
            </p>
          </>
        ) : (
          <p className="text-xs text-muted">
            Not set up yet. Create a dedicated mailbox (a fresh Gmail with an app password
            works), put its IMAP credentials in <span className="font-mono">.env.local</span>{" "}
            (INBOUND_EMAIL_HOST / USER / PASSWORD), and this becomes the address you forward
            things to.
          </p>
        )}
      </section>

      <section className="rounded-xl border border-edge bg-surface p-5">
        <h2 className="mb-1 text-sm font-bold">Notifications</h2>
        <p className="mb-4 text-xs text-muted">
          Reminders you set with the secretary ring this device at the exact time, and
          the shop pings you when a plan is ready or a build ships. Add the app to your
          Home Screen first on iPhone.
        </p>
        <NotificationsSection />
      </section>

      <section className="rounded-xl border border-edge bg-surface p-5">
        <h2 className="mb-1 text-sm font-bold">Connected accounts</h2>
        <p className="mb-4 text-xs text-muted">
          Your login here is your account. Connecting your own Claude API key makes the
          brain features — conversation parsing, canvas, Claude chat — run and bill on
          your Anthropic account.
        </p>
        <ConnectedAccounts />
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

      <SpendSummary initial={spend} allTime={allTime} />

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
