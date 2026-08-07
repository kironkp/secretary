// Transactional email via Resend (F-7). EMAIL_FROM stays onboarding@resend.dev
// until a domain is verified. Without RESEND_API_KEY (e.g. fresh clone), links
// are logged to the server console so auth flows stay testable in dev.
import { Resend } from "resend";

const apiKey = process.env.RESEND_API_KEY;
const resend = apiKey ? new Resend(apiKey) : null;
const FROM = process.env.EMAIL_FROM ?? "Secretary <onboarding@resend.dev>";

function template(title: string, body: string, url: string, cta: string) {
  return `
  <div style="background:#0f1115;padding:40px 16px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
    <div style="max-width:440px;margin:0 auto;background:#171a21;border:1px solid #2e3442;border-radius:12px;padding:32px;">
      <p style="color:#7aa2ff;font-weight:700;font-size:14px;margin:0 0 16px;">Secretary</p>
      <h1 style="color:#e8eaf0;font-size:20px;margin:0 0 12px;">${title}</h1>
      <p style="color:#9aa3b5;font-size:14px;line-height:1.5;margin:0 0 24px;">${body}</p>
      <a href="${url}" style="display:inline-block;background:#7aa2ff;color:#0f1115;font-weight:600;font-size:14px;padding:10px 20px;border-radius:8px;text-decoration:none;">${cta}</a>
      <p style="color:#6b7386;font-size:12px;margin:24px 0 0;">If you didn't request this, you can safely ignore it.</p>
    </div>
  </div>`;
}

async function send(to: string, subject: string, html: string, url: string) {
  if (!resend) {
    console.log(`[email:dev-fallback] RESEND_API_KEY not set — ${subject} for ${to}`);
    console.log(`[email:dev-fallback] link: ${url}`);
    return;
  }
  const { error } = await resend.emails.send({ from: FROM, to, subject, html });
  if (error) throw new Error(`Resend failed: ${error.message}`);
}

export function sendVerificationEmail(to: string, url: string) {
  return send(
    to,
    "Verify your email",
    template(
      "Verify your email",
      "Welcome! Confirm this address and your secretary gets to work.",
      url,
      "Verify email"
    ),
    url
  );
}

export function sendResetPasswordEmail(to: string, url: string) {
  return send(
    to,
    "Reset your password",
    template(
      "Reset your password",
      "Someone (hopefully you) asked to reset the password for this account. The link expires shortly.",
      url,
      "Choose a new password"
    ),
    url
  );
}
