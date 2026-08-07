import { Suspense } from "react";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/session";
import { listConnectedAccounts } from "@yoink/backend/web";
import { Integrations } from "@/components/integrations";

export const dynamic = "force-dynamic";

export default async function IntegrationsPage() {
  const user = await getSessionUser();
  if (!user) redirect("/sign-in");

  const accounts = await listConnectedAccounts(user.id).catch(() => []);
  const x = accounts.find((account) => account.platform === "x") ?? null;
  const linkedIn = accounts.find((account) => account.platform === "linkedin") ?? null;

  return (
    <Suspense fallback={<div style={{ padding: 24 }}>Loading…</div>}>
      <Integrations
        x={x ? { handle: x.handle, status: x.status } : null}
        linkedIn={linkedIn ? { handle: linkedIn.handle, status: linkedIn.status } : null}
      />
    </Suspense>
  );
}
