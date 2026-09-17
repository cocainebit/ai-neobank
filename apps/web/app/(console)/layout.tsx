"use client";

import { SessionProvider } from "../../components/session";
import { Shell } from "../../components/shell";
import { ToastProvider } from "../../components/ui";

export default function ConsoleLayout({ children }: { children: React.ReactNode }) {
  return (
    <ToastProvider>
      <SessionProvider>
        <Shell>{children}</Shell>
      </SessionProvider>
    </ToastProvider>
  );
}
