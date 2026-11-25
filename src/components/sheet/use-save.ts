"use client";

import { useCallback, useState } from "react";
import { saveFile } from "./bits";

export function useSave(): { save: (name: string, body: () => string | Uint8Array<ArrayBuffer>, type?: string) => void; error: Error | null } {
  const [error, setError] = useState<Error | null>(null);
  const save = useCallback((name: string, body: () => string | Uint8Array<ArrayBuffer>, type?: string) => {
    try {
      setError(null);
      saveFile(name, body(), type);
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
    }
  }, []);
  return { save, error };
}
