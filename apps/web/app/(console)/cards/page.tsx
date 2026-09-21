"use client";

import { CardsPanel } from "../../../components/cards-panel";
import { PageHead } from "../../../components/ui";

export default function CardsPage() {
  return (
    <>
      <PageHead
        title="Cards"
        description="Debit cards that spend from a treasury you already hold. Nothing has been issued: Relay has no card provider behind it yet, and cards stay locked until the business is verified."
      />
      <CardsPanel />
    </>
  );
}
