"use client";

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

type PageMeta = {
  count: number | null;
  setCount: (value: number | null) => void;
};

const PageMetaContext = createContext<PageMeta | null>(null);

export function PageMetaProvider({ children }: { children: ReactNode }) {
  const [count, setCount] = useState<number | null>(null);
  const value = useMemo(() => ({ count, setCount }), [count]);
  return <PageMetaContext.Provider value={value}>{children}</PageMetaContext.Provider>;
}

export function usePageCount(count: number | null) {
  const ctx = useContext(PageMetaContext);
  useEffect(() => {
    if (!ctx) return;
    ctx.setCount(count);
    return () => ctx.setCount(null);
  }, [ctx, count]);
}

export function usePageMeta() {
  return useContext(PageMetaContext);
}
