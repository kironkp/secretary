import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { getDocumentDetail } from "@/lib/db/queries";
import { DocumentView } from "@/components/documents/document-view";

export default async function DocumentPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/sign-in");
  const { id } = await params;

  const detail = await getDocumentDetail(session.user.id, id);
  if (!detail) notFound();

  return (
    <DocumentView
      id={detail.doc.id}
      initialTitle={detail.doc.title}
      initialProject={detail.projectName}
      initialSections={detail.doc.sections}
      initialVersions={detail.versions.map((v) => ({
        id: v.id,
        title: v.title,
        note: v.note,
        savedAt: v.savedAt.toISOString(),
      }))}
      initialUpdatedAt={detail.doc.updatedAt.toISOString()}
    />
  );
}
