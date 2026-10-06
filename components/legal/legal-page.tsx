// The frame the public Privacy and Terms pages share (SEC-A010): readable on
// a phone, no sign-in, no scripts of its own, no tracking.
import Link from "next/link";
import { contactEmail, LEGAL } from "@/lib/legal";

export function LegalPage({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="mx-auto max-w-2xl px-5 py-10 text-[15px] leading-relaxed">
      <p className="text-sm text-faint">
        <Link href="/privacy" className="text-accent">
          Privacy
        </Link>{" "}
        ·{" "}
        <Link href="/terms" className="text-accent">
          Terms
        </Link>
      </p>
      <h1 className="mt-4 text-[30px] font-bold leading-tight">
        {LEGAL.app}: {title}
      </h1>
      <p className="mt-1 text-sm text-faint">Last updated {LEGAL.updated}</p>
      <div className="legal mt-6 space-y-4 [&_h2]:mt-8 [&_h2]:text-lg [&_h2]:font-bold [&_li]:ml-5 [&_li]:list-disc [&_a]:text-accent [&_a]:underline">
        {children}
      </div>
    </main>
  );
}

/** How to reach the operator: the published address, or where to find it. */
export function Contact() {
  const email = contactEmail();
  return email ? (
    <a href={`mailto:${email}`}>{email}</a>
  ) : (
    <>the developer contact address shown on the app&apos;s Google consent screen</>
  );
}
