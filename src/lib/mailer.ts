// src/lib/mailer.ts
//
// Transactional email via Resend (resend.com — free tier, no card
// required for low volume). Requires env var RESEND_API_KEY.
//
// Until that's configured, sendPasswordResetEmail() falls back to
// logging the code to the console instead of failing, so the reset
// flow is fully testable in dev before the email provider is set up.

import { Resend } from "resend";

const apiKey = process.env.RESEND_API_KEY;
const resend = apiKey ? new Resend(apiKey) : null;
const FROM = process.env.EMAIL_FROM || "Lumora <onboarding@resend.dev>";
const REPLY_TO = process.env.EMAIL_REPLY_TO;

export async function sendPasswordResetEmail(email: string, code: string) {
  if (!resend) {
    console.log(`[mailer] RESEND_API_KEY not set — password reset code for ${email}: ${code}`);
    return;
  }

  const { error } = await resend.emails.send({
    from: FROM,
    to: email,
    ...(REPLY_TO ? { replyTo: REPLY_TO } : {}),
    subject: "Your Lumora password reset code",
    html: `
      <p>Use this code to reset your Lumora password:</p>
      <p style="font-size: 28px; font-weight: 700; letter-spacing: 4px;">${code}</p>
      <p>This code expires in 15 minutes. If you didn't request this, you can ignore this email.</p>
    `,
  });

  if (error) {
    console.error("[mailer] Failed to send password reset email:", error);
    throw new Error("Could not send reset email");
  }
}
