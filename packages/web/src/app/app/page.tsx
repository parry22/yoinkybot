import { redirect } from "next/navigation";

// The app landing. Agent is a section (Compose + Automation), not a page, so we
// send people to Compose. The Connect-X gate in the layout still fires here.
export default function AppIndexPage() {
  redirect("/app/compose");
}
