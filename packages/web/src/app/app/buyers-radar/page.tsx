import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/session";
import { BuyersRadar } from "@/components/buyers-radar";
import { buyerRadarStatus, listBuyerSignals, getBuyerIcp, buyerIcpPrefill } from "@yoink/backend/web";

export const dynamic = "force-dynamic";

export default async function BuyersRadarPage() {
  const user = await getSessionUser();
  if (!user) redirect("/sign-in");
  const [status, signals, icp, prefill] = await Promise.all([
    buyerRadarStatus(user.id),
    listBuyerSignals(user.id),
    getBuyerIcp(user.id),
    buyerIcpPrefill(user.id),
  ]);
  return <BuyersRadar status={status} initialSignals={signals} icp={icp} prefill={prefill} />;
}
