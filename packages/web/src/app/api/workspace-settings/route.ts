import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { addWorkspaceExpert,addWorkspaceMemberByEmail,deleteCompanyWorkspace,exportWorkspaceData,resolveWorkspaceContext,setWorkspaceTelegramDelivery,updateWorkspaceMemberRole,updateWorkspaceProfile,updateWorkspaceSource } from "@yoink/backend/web";

export const runtime="nodejs";
export const dynamic="force-dynamic";

export async function GET(){const user=await getSessionUser();if(!user)return NextResponse.json({error:"Unauthorized"},{status:401});const workspace=await resolveWorkspaceContext(user.id);if(!workspace)return NextResponse.json({error:"No active workspace."},{status:400});try{return NextResponse.json(await exportWorkspaceData(user.id,workspace.id),{headers:{"content-disposition":`attachment; filename="${workspace.slug}-export.json"`}});}catch(error){return NextResponse.json({error:error instanceof Error?error.message:"Could not export workspace."},{status:400});}}

export async function POST(req:Request){
  const user=await getSessionUser();if(!user)return NextResponse.json({error:"Unauthorized"},{status:401});
  const workspace=await resolveWorkspaceContext(user.id);if(!workspace)return NextResponse.json({error:"No active workspace."},{status:400});
  const body=await req.json().catch(()=>({})) as Record<string,unknown>;
  try{
    if(body.action==="telegram"){await setWorkspaceTelegramDelivery(user.id,workspace.id,body.enabled===true);return NextResponse.json({ok:true});}
    if(body.action==="profile"){await updateWorkspaceProfile(user.id,workspace.id,{description:typeof body.description==="string"?body.description:null,industry:typeof body.industry==="string"?body.industry:null,website:typeof body.website==="string"?body.website:null,primaryObjective:typeof body.primaryObjective==="string"?body.primaryObjective:null,primaryObjectiveKey:typeof body.primaryObjectiveKey==="string"?body.primaryObjectiveKey:null});return NextResponse.json({ok:true});}
    if(body.action==="source"){if(typeof body.sourceId!=="string"||typeof body.permissionLevel!=="string"||typeof body.status!=="string")throw new Error("Source settings are required.");await updateWorkspaceSource(user.id,workspace.id,body.sourceId,{permissionLevel:body.permissionLevel,status:body.status});return NextResponse.json({ok:true});}
    if(body.action==="add_member"){if(typeof body.email!=="string"||typeof body.role!=="string")throw new Error("Email and role are required.");await addWorkspaceMemberByEmail(user.id,workspace.id,body.email,body.role as never);return NextResponse.json({ok:true});}
    if(body.action==="member_role"){if(typeof body.userId!=="string"||typeof body.role!=="string")throw new Error("Member and role are required.");await updateWorkspaceMemberRole(user.id,workspace.id,body.userId,body.role as never);return NextResponse.json({ok:true});}
    if(body.action==="add_expert"){if(typeof body.name!=="string"||typeof body.expertType!=="string")throw new Error("Expert name and type are required.");return NextResponse.json({expert:await addWorkspaceExpert(user.id,workspace.id,{name:body.name,title:typeof body.title==="string"?body.title:null,expertType:body.expertType as never,isPublicVoice:body.isPublicVoice===true})},{status:201});}
    if(body.action==="delete"){if(typeof body.confirmation!=="string")throw new Error("Confirmation is required.");await deleteCompanyWorkspace(user.id,workspace.id,body.confirmation);return NextResponse.json({ok:true});}
    return NextResponse.json({error:"Unknown action."},{status:400});
  }catch(error){return NextResponse.json({error:error instanceof Error?error.message:"Could not update workspace."},{status:400});}
}
