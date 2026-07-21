import { redirect } from "next/navigation";

// Onboarding is no longer a question wizard. Signing in + the mandatory
// Connect-X gate (shown by the app layout) is the whole setup; the agent asks
// anything else it needs in chat. This route just forwards into the app.
export default function OnboardingPage() {
  redirect("/app");
}
