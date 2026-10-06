// The public terms (SEC-A010). No sign-in: outside the (app) group.
import type { Metadata } from "next";
import Link from "next/link";
import { Contact, LegalPage } from "@/components/legal/legal-page";
import { LEGAL } from "@/lib/legal";

export const dynamic = "force-dynamic"; // the contact address is read per request
export const metadata: Metadata = { title: `Terms · ${LEGAL.app}` };

export default function TermsPage() {
  return (
    <LegalPage title="Terms of use">
      <p>
        {LEGAL.app} is a personal assistant app built and operated by {LEGAL.operator} for his own use. It is not
        offered to the public, and there is no charge for it.
      </p>
      <h2>Using it</h2>
      <ul>
        <li>Use it only with accounts and data you are entitled to use.</li>
        <li>
          It acts only on what you ask. It can be wrong: check what it adds or changes, and send any email draft
          yourself only after reading it. It never sends email.
        </li>
        <li>
          Connecting Google is optional, and you can disconnect it in Settings at any time. How Google data is used
          is in the <Link href="/privacy">privacy policy</Link>.
        </li>
      </ul>
      <h2>No warranty</h2>
      <p>
        It is provided as is, without warranty of any kind. To the extent the law allows, the operator is not
        liable for loss arising from its use.
      </p>
      <h2>Changes and contact</h2>
      <p>
        These terms may change; the date above says when they last did. Contact: <Contact />.
      </p>
    </LegalPage>
  );
}
