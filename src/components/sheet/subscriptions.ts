"use client";

import { hashKey, useQueryClient, type DataTag, type QueryKey, type QueryState } from "@tanstack/react-query";
import { useCallback, useState, useSyncExternalStore } from "react";

const unchanged = (): null => null;

type Picked = object | string | number | boolean | null;

function clockStore(everyMs: number) {
  let now = Date.now();
  return {
    read: (): number => now,
    subscribe: (changed: () => void): (() => void) => {
      const timer = setInterval(() => { now = Date.now(); changed(); }, everyMs);
      return () => clearInterval(timer);
    },
  };
}

export function useClock(everyMs: number): number {
  const [clock] = useState(() => clockStore(everyMs));
  return useSyncExternalStore(clock.subscribe, clock.read, clock.read);
}

export function useQueryChange<TData, V extends Picked>(
  queryKey: DataTag<QueryKey, TData, unknown>,
  pick: (state: QueryState<TData, unknown> | undefined) => V,
  onChange: (next: V, previous: V | undefined) => void,
): void {
  const queryClient = useQueryClient();
  const queryHash = hashKey(queryKey);
  const subscribe = useCallback(() => {
    const cache = queryClient.getQueryCache();
    const read = (): V => pick(cache.get<TData, unknown>(queryHash)?.state);
    let last = read();
    onChange(last, undefined);
    return cache.subscribe((event) => {
      if (event.query.queryHash !== queryHash) return;
      const next = read();
      if (Object.is(next, last)) return;
      const previous = last;
      last = next;
      onChange(next, previous);
    });
  }, [queryClient, queryHash, pick, onChange]);
  useSyncExternalStore(subscribe, unchanged, unchanged);
}
