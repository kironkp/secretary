import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";

export default async function Home() {
  const session = await auth.api.getSession({ headers: await headers() });
  // Today is the front door (docs/understanding/SPEC.md §9): the one question
  // whose answer changes tomorrow comes before any list.
  redirect(session ? "/today" : "/sign-in");
}
