"use client";

import { useEffect, useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Building02Icon, Tick02Icon, UnfoldMoreIcon, UserCircleIcon } from "@hugeicons/core-free-icons";
import type { WorkspaceSummary } from "@yoink/backend/web";
import styles from "./workspace-switcher.module.css";

export function WorkspaceSwitcher({
  workspaces,
  compact = false,
}: {
  workspaces: WorkspaceSummary[];
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const active = workspaces.find((workspace) => workspace.active) ?? workspaces[0];

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!active) return null;

  async function select(workspaceId: string) {
    if (workspaceId === active?.id) {
      setOpen(false);
      return;
    }
    setSwitching(workspaceId);
    const response = await fetch("/api/workspaces", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId }),
    });
    if (response.ok) {
      window.location.assign("/app");
      return;
    }
    setSwitching(null);
  }

  return (
    <div className={`${styles.wrap} ${compact ? styles.wrapCompact : ""}`} ref={wrapRef}>
      <button
        type="button"
        className={`${styles.trigger} ${compact ? styles.triggerCompact : ""}`}
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={active.name}
        aria-label={`Workspace: ${active.name}`}
      >
        <span className={styles.mark}>
          <HugeiconsIcon icon={active.workspaceType === "company" ? Building02Icon : UserCircleIcon} size={17} />
        </span>
        <span className={styles.labelWrap}>
          <span className={styles.name}>{active.name}</span>
          <span className={styles.kind}>{active.workspaceType === "company" ? "Company workspace" : "Personal workspace"}</span>
        </span>
        <HugeiconsIcon icon={UnfoldMoreIcon} size={15} className={styles.chevron} />
      </button>

      {open && (
        <div className={`${styles.menu} ${compact ? styles.menuCompact : ""}`} role="menu">
          <p className={styles.menuLabel}>Workspaces</p>
          {workspaces.map((workspace) => (
            <button
              key={workspace.id}
              type="button"
              role="menuitem"
              className={styles.item}
              disabled={switching !== null}
              onClick={() => void select(workspace.id)}
            >
              <span className={styles.itemMark}>
                <HugeiconsIcon icon={workspace.workspaceType === "company" ? Building02Icon : UserCircleIcon} size={16} />
              </span>
              <span className={styles.itemCopy}>
                <span className={styles.itemName}>{workspace.name}</span>
                <span className={styles.itemMeta}>{workspace.role}</span>
              </span>
              {workspace.active && <HugeiconsIcon icon={Tick02Icon} size={15} className={styles.tick} />}
              {switching === workspace.id && <span className={styles.loading}>…</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
