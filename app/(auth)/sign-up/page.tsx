import { socialProvidersEnabled } from "@/lib/auth";
import { SignUpForm } from "@/components/auth/sign-up-form";

export default function SignUpPage() {
  return (
    <SignUpForm
      google={socialProvidersEnabled.google}
      apple={socialProvidersEnabled.apple}
    />
  );
}
