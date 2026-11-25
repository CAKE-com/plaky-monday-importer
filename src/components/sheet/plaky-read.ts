"use client";

import { useQuery } from "@tanstack/react-query";

type PlakyRead<T> = { data: T | undefined; error: Error | null; isSuccess: boolean; isPending: boolean; read: () => void };

export function usePlakyRead<T>(procedure: string, migrationId: number, read: () => Promise<T>): PlakyRead<T> {
  const query = useQuery({
    queryKey: ["plaky-read", procedure, migrationId], queryFn: read,
    retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false, staleTime: Infinity, gcTime: 0,
  });
  const settled = !query.isFetching;
  const answered = settled && query.status === "success";
  return { data: answered ? query.data : undefined, error: settled ? query.error : null, isSuccess: answered, isPending: query.isFetching, read: () => void query.refetch() };
}
