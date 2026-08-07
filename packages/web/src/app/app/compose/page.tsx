import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/session";
import { listContentBriefs, listDrafts, listExperts, listNarrativeSystems, resolveWorkspaceContext } from "@yoink/backend/web";
import { Compose } from "@/components/compose";

export const dynamic = "force-dynamic";

export default async function ComposePage({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}) {
  const user = await getSessionUser();
  if (!user) redirect("/sign-in");

  const workspace=await resolveWorkspaceContext(user.id);const params=await searchParams;const briefId=Array.isArray(params.briefId)?params.briefId[0]:params.briefId;
  const [drafts,briefs,experts,narratives] = await Promise.all([listDrafts(user.id).catch(() => []),workspace?listContentBriefs(user.id,workspace.id):Promise.resolve([]),workspace?listExperts(user.id,workspace.id):Promise.resolve([]),workspace?listNarrativeSystems(user.id,workspace.id):Promise.resolve([])]);
  const selectedBrief=briefs.find(item=>item.id===briefId)??null;
  return (
    <Compose
      initialDrafts={drafts.map((d) => ({
        id: d.id,
        content: d.content,
        platform: d.platform,
        created_at: d.created_at,
      }))}
      workspaceContext={workspace?{id:workspace.id,name:workspace.name,type:workspace.workspaceType,expert:experts.find(item=>item.isDefault)?.name??null,narrativeVersion:narratives.find(item=>item.status==="active")?.version??null,brief:selectedBrief}:null}
    />
  );
}
