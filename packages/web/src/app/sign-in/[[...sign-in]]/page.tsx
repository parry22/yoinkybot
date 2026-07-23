import { SignIn } from "@clerk/nextjs";

export const dynamic = "force-dynamic";

export default function SignInPage() {
  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 20,
        background: "var(--main-bg)",
        padding: 24,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 20, fontWeight: 470, color: "var(--ink-900)" }}>
        <img src="/favicon.png" alt="" style={{ width: 24, height: 24, objectFit: "contain" }} />
        Yoinky
      </div>
      <SignIn signUpUrl="/sign-up" forceRedirectUrl="/app" />
    </div>
  );
}
