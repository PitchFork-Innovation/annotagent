import { notFound } from "next/navigation";
import { AnnotationWorkspace } from "@/components/workspace/annotation-workspace";
import { getPaperWorkspace } from "@/lib/server-data";

type Props = {
  params: Promise<{
    paperId: string;
  }>;
};

export default async function PaperPage({ params }: Props) {
  const { paperId } = await params;
  const workspace = await getPaperWorkspace(paperId);

  if (!workspace) {
    notFound();
  }

  return <AnnotationWorkspace workspace={workspace} />;
}
