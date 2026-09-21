"use client";

import { VerificationApplication } from "../../../components/verification-application";
import { PageHead } from "../../../components/ui";

export default function VerificationPage() {
  return (
    <>
      <PageHead
        title="Verification"
        description="Say who the business is, attest to it with your wallet, and have a named person record a decision. Nothing here is checked: Floatlane has no verification provider connected, so verified means a person decided, and this page says so on every screen."
      />
      <VerificationApplication />
    </>
  );
}
