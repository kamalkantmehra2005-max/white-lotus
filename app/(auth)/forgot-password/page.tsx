import { ForgotPasswordForm, LocalPasswordReset } from "@/components/auth/reset-forms";

export const metadata = { title: "Reset password" };
export const dynamic = "force-dynamic";

export default function Page() {
  // Local install: no email service by default, so the reset happens on this computer with the launcher.
  const emailConfigured = Boolean(process.env.RESEND_API_KEY || process.env.POSTMARK_SERVER_TOKEN);
  return emailConfigured ? <ForgotPasswordForm /> : <LocalPasswordReset />;
}
