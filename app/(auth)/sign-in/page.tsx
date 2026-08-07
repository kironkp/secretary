import { socialProvidersEnabled } from "@/lib/auth";
import { SignInForm } from "@/components/auth/sign-in-form";

export default function SignInPage() {
  return (
    <SignInForm
      google={socialProvidersEnabled.google}
      apple={socialProvidersEnabled.apple}
    />
  );
}
