import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";

export default async function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (session) redirect("/chat");

  return (
    <div className="flex flex-1 flex-col items-center justify-center px-4 py-12">
      <p className="mb-6 text-lg font-bold tracking-tight text-accent">Secretary</p>
      <div className="w-full max-w-sm rounded-2xl border border-edge bg-surface p-8 shadow-2xl shadow-black/40">
        {children}
      </div>
      <p className="mt-6 max-w-sm text-center text-xs text-faint">
        A genius secretary you talk to.
      </p>
    </div>
  );
}
