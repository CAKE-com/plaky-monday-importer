"use client";

import { QueryClient, QueryClientProvider, focusManager } from "@tanstack/react-query";
import { createTRPCClient, httpBatchLink, httpSubscriptionLink, splitLink } from "@trpc/client";
import { createTRPCContext } from "@trpc/tanstack-react-query";
import { useState } from "react";
import type { AppRouter } from "@/server/trpc/router";
import { MAX_BATCH } from "@/lib/trpc-limits";

export const { TRPCProvider, useTRPC, useTRPCClient } = createTRPCContext<AppRouter>();

focusManager.setEventListener((regained) => {
  if (typeof window === "undefined") return undefined;
  const onReturn = (): void => regained();
  window.addEventListener("visibilitychange", onReturn);
  window.addEventListener("focus", onReturn);
  return () => {
    window.removeEventListener("visibilitychange", onReturn);
    window.removeEventListener("focus", onReturn);
  };
});

export function TRPCReactProvider({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, staleTime: 0 } } }));
  const [client] = useState(() =>
    createTRPCClient<AppRouter>({
      links: [
        splitLink({
          condition: (op) => op.type === "subscription",
          true: httpSubscriptionLink({ url: "/api/trpc" }),
          false: httpBatchLink({ url: "/api/trpc", maxItems: MAX_BATCH }),
        }),
      ],
    }),
  );
  return (
    <QueryClientProvider client={queryClient}>
      <TRPCProvider trpcClient={client} queryClient={queryClient}>
        {children}
      </TRPCProvider>
    </QueryClientProvider>
  );
}
