import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/session";
import { setIntendedPlan } from "@yoink/backend/web";

export const dynamic = "force-dynamic";

const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

export default async function AppHomePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await getSessionUser();
  if (!user) redirect("/sign-in");
  const plan = one((await searchParams).plan);
  if (plan) await setIntendedPlan(user.id, plan).catch(() => {});
  redirect("/app/knowledge");
}
