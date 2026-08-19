import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { CanvasView } from "@/components/canvas/canvas-view";

export default async function CanvasPage() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/sign-in");
  return (
    <div className="py-2">
      <h1 className="mb-3 text-lg font-bold">Canvas</h1>
      <CanvasView />
    </div>
  );
}
