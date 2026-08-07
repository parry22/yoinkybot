import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/session";
import {
  ensurePersonalWorkspace,
  listWorkspacesForUser,
  trialInfo,
} from "@yoink/backend/web";
import { AppShell } from "@/components/app-shell";
import styles from "./shell.module.css";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser();
  if (!user) redirect("/sign-in");

  await ensurePersonalWorkspace(user.id);
  const [trial, workspaces] = await Promise.all([
    trialInfo(user.id).catch(() => null),
    listWorkspacesForUser(user.id),
  ]);

  return (
    <div className={styles.shell}>
      <AppShell trial={trial} workspaces={workspaces}>{children}</AppShell>
    </div>
  );
}
