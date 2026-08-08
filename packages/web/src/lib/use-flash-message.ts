"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/** Soft toast-style message that clears itself after a few seconds. */
export function useFlashMessage(ms = 4200) {
  const [message, setMessage] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clear = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setMessage("");
  }, []);

  const flash = useCallback(
    (next: string) => {
      if (timer.current) clearTimeout(timer.current);
      setMessage(next);
      if (!next) {
        timer.current = null;
        return;
      }
      timer.current = setTimeout(() => {
        setMessage("");
        timer.current = null;
      }, ms);
    },
    [ms],
  );

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  return { message, flash, clear } as const;
}
