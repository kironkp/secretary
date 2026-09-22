import { Suspense } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { DockedChat } from "@/components/chat/docked-chat";
import { VoiceCallProvider } from "@/components/chat/voice-call-provider";
import { DetailDialog } from "@/components/shell/detail-dialog";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/sign-in");

  return (
    // VoiceCallProvider wraps the whole shell: a live call is owned HERE, so
    // switching tabs (or opening the floating chat) never hangs it up.
    <VoiceCallProvider>
    <div className="flex h-dvh flex-col">
      {/* No header. The "Secretary on iPhone" mockup opens straight on the
          page: the date line and the large title are the top of the screen,
          and the tabs live at the bottom with the ask bar (DockedChat). The
          overdue and due-today counts are on Today; the theme toggle is in
          Settings. */}
      <main className="min-h-0 flex-1 overflow-y-auto">
        {/* pb clears the docked chat so page bottoms stay reachable: its real
            height, published by components/chat/dock-height.tsx, plus a
            breath; 6rem until the dock has measured itself. */}
        <div className="mx-auto h-full w-full max-w-7xl px-4 pb-[calc(var(--dock-h,6rem)+1.5rem)]">
          {children}
        </div>
      </main>
      <DetailDialog />
      {/* Chat is not a tab (SPEC §7.7): the dock rides every page. Suspense
          because it reads searchParams for the ?c= push-receipt deep link. */}
      <Suspense fallback={null}>
        <DockedChat />
      </Suspense>
    </div>
    </VoiceCallProvider>
  );
}
