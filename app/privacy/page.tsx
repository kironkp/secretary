// The public privacy policy (SEC-A010). No sign-in: it lives outside the
// (app) group, whose layout is what requires one. Every statement here is
// what the code does; change them together.
import type { Metadata } from "next";
import { Contact, LegalPage } from "@/components/legal/legal-page";
import { GOOGLE_PERMISSIONS_URL, LEGAL, LIMITED_USE } from "@/lib/legal";

export const dynamic = "force-dynamic"; // the contact address is read per request
export const metadata: Metadata = { title: `Privacy · ${LEGAL.app}` };

export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy policy">
      <p>
        {LEGAL.app} is a personal assistant app built and operated by {LEGAL.operator} for his own use. It is not a
        product offered to the public. This page says what it keeps, what it does with Google data, and who else
        processes it.
      </p>

      <h2>What the app stores</h2>
      <ul>
        <li>Your account: name, email address, time zone, and how you sign in.</li>
        <li>What you work with: tasks, events, projects, lists, notes and documents, and facts you asked it to remember.</li>
        <li>Conversations: what you type or say to it and what it answers, kept as your history; files you attach.</li>
        <li>Usage records: how many AI tokens each request used and what it cost, so spending can be capped.</li>
        <li>
          Connected-account tokens, such as the token that lets it reach your Google account. These are encrypted
          (AES-GCM) before they are stored.
        </li>
      </ul>
      <p>It is stored in a database hosted on Heroku. It is kept until you delete it or the account is removed.</p>

      <h2>Google data</h2>
      <p>The app asks for Google access only when you connect it in Settings, and uses it only for what you ask:</p>
      <ul>
        <li>
          <strong>Google Calendar</strong> (events on calendars you own): it creates, changes and deletes events
          when you ask it to, by voice or chat. It stores the Google event id next to its own copy of the event so
          it can update the same one later.
        </li>
        <li>
          <strong>Gmail</strong> (read, and write drafts): when you ask, it lists recent mail, searches it, reads a
          message, or saves a reply as a draft in your Gmail, addressed only to the person who wrote to you. It
          never sends email; you send drafts yourself from Gmail. Email messages are not stored in the app&apos;s
          database. The assistant&apos;s own reply in a conversation, which may summarize a message, is kept with
          that conversation&apos;s history.
        </li>
        <li>
          <strong>Google sign-in</strong>, if you use it: your name, email address and profile picture, to sign you
          in.
        </li>
      </ul>
      <p>
        {LIMITED_USE.before}
        <a href={LIMITED_USE.policy.href}>{LIMITED_USE.policy.text}</a>
        {LIMITED_USE.middle}
        <a href={LIMITED_USE.limitedUse.href}>{LIMITED_USE.limitedUse.text}</a>
        {LIMITED_USE.after}
      </p>
      <p>
        Google user data is used only to provide the features above. It is not sold, not used for advertising, not
        used to train AI models, and not read by people except at your request or where the law requires.
      </p>

      <h2>AI and other services</h2>
      <ul>
        <li>
          <strong>Anthropic and OpenAI</strong> process what you say and type, and what the app gives the assistant
          to answer you, including the text of an email you asked about. Voice is handled by OpenAI.
        </li>
        <li>
          <strong>ElevenLabs</strong> turns the assistant&apos;s replies into speech when that voice is turned on.
        </li>
        <li>
          <strong>Resend</strong> sends sign-in and account email; <strong>Heroku</strong> hosts the app and its
          database; your browser&apos;s push service delivers notifications you turned on.
        </li>
      </ul>
      <p>Each processes data only to provide its part of the app, under its own terms.</p>

      <h2>Disconnecting and revoking</h2>
      <p>
        In the app, Settings disconnects Google: the stored tokens are deleted and the access is revoked at Google.
        You can also remove the app&apos;s access at any time at{" "}
        <a href={GOOGLE_PERMISSIONS_URL}>myaccount.google.com/permissions</a>.
      </p>

      <h2>Contact</h2>
      <p>
        Questions, or a request to delete your data: <Contact />.
      </p>
    </LegalPage>
  );
}
