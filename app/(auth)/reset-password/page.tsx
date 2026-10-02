import { Suspense } from "react";
import { ResetPasswordForm } from "@/components/auth/reset-forms";

export const metadata = { title: "Choose a new password" };
export default function Page() {
  return (
    <Suspense>
      <ResetPasswordForm />
    </Suspense>
  );
}
