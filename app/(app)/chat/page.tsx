import { redirect } from "next/navigation";

// Chat is not a tab anymore (SPEC §7.7) — it lives in the bottom dock on
// every page. This route survives only for old deep links (push receipts use
// /chat?c=…): forward them to the dashboard, where the dock reads ?c= and
// opens fully on that conversation.
export default async function ChatRedirect({
  searchParams,
}: {
  searchParams: Promise<{ c?: string; m?: string }>;
}) {
  const { c, m } = await searchParams;
  const q = new URLSearchParams();
  if (c) q.set("c", c);
  if (m) q.set("m", m);
  redirect(q.size ? `/dashboard?${q}` : "/dashboard");
}
