import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import {
  createCompanyWorkspace,
  ensurePersonalWorkspace,
  listWorkspacesForUser,
  setActiveWorkspace,
} from "@yoink/backend/web";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  await ensurePersonalWorkspace(user.id);
  return NextResponse.json({ workspaces: await listWorkspacesForUser(user.id) });
}

export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    const workspace = await createCompanyWorkspace(user.id, {
      name: typeof body.name === "string" ? body.name : "",
      description: typeof body.description === "string" ? body.description : null,
      primaryObjective: typeof body.primaryObjective === "string" ? body.primaryObjective : null,
      founderName: typeof body.founderName === "string" ? body.founderName : null,
      founderTitle: typeof body.founderTitle === "string" ? body.founderTitle : null,
    });
    return NextResponse.json({ workspace }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not create workspace.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function PATCH(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { workspaceId?: unknown };
  if (typeof body.workspaceId !== "string") {
    return NextResponse.json({ error: "Workspace is required." }, { status: 400 });
  }
  try {
    const workspace = await setActiveWorkspace(user.id, body.workspaceId);
    return NextResponse.json({ workspace });
  } catch {
    return NextResponse.json({ error: "You do not have access to this workspace." }, { status: 403 });
  }
}

