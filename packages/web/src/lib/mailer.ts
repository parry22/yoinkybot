import "server-only";

/**
 * Send a magic-link email. If a provider is configured (Resend today), it goes
 * out for real; otherwise the link is logged to the server console so local dev
 * works with zero mail setup. Returns whether a real email was dispatched.
 */
export async function sendMagicLink(email: string, link: string): Promise<boolean> {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.MAIL_FROM ?? "Yoinky <login@meetyoinky.com>";

  if (!key) {
    console.log(`[magic-link] no RESEND_API_KEY set — login link for ${email}:\n${link}`);
    return false;
  }

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        from,
        to: email,
        subject: "Your Yoinky sign-in link",
        html: `<p>Tap to sign in to Yoinky. This link expires in 30 minutes.</p><p><a href="${link}">Sign in</a></p><p style="color:#888;font-size:12px">If you didn't request this, ignore it.</p>`,
      }),
    });
    if (!res.ok) {
      console.error(`[magic-link] Resend failed (${res.status}) — link for ${email}:\n${link}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error("[magic-link] send failed, logging link instead:", err);
    console.log(`[magic-link] login link for ${email}:\n${link}`);
    return false;
  }
}
