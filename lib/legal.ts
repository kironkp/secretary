// The facts the public Privacy and Terms pages state (SEC-A010), in one
// place. The contact address is the operator's to publish: it comes from
// PUBLIC_CONTACT_EMAIL (the developer contact on the Google consent screen),
// read on every request so a config change shows without a rebuild. Unset,
// the pages point to that consent-screen contact instead of inventing one.
export const LEGAL = {
  app: "Secretary",
  // Not a person's name: the owner's choice (SEC-A010 review).
  operator: "the app's owner",
  updated: "October 6, 2026",
} as const;

export function contactEmail(): string | null {
  const v = process.env.PUBLIC_CONTACT_EMAIL?.trim();
  return v && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? v : null;
}

/** Google's own wording (Google Workspace API user data and developer policy), with its links. */
export const LIMITED_USE = {
  before: "The use of information received from Google Workspace scopes will adhere to the ",
  policy: { text: "Google User Data Policy", href: "https://developers.google.com/terms/api-services-user-data-policy" },
  middle: ", including the ",
  limitedUse: {
    text: "Limited Use requirements",
    href: "https://developers.google.com/terms/api-services-user-data-policy#additional_requirements_for_specific_api_scopes",
  },
  after: ".",
  source: "https://developers.google.com/workspace/workspace-api-user-data-developer-policy",
} as const;

export const GOOGLE_PERMISSIONS_URL = "https://myaccount.google.com/permissions";
