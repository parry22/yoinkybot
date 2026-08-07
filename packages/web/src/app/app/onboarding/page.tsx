import { redirect } from "next/navigation";

// Onboarding is no longer a question wizard. People can start using Yoinky as
// soon as they sign in, then connect X or LinkedIn from Settings when they want
// history-based voice learning, publishing, or a diagnosis. This route forwards
// into the app for older links.
export default function OnboardingPage() {
  redirect("/app");
}
