"use client";

import { useEffect, useId, useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import styles from "./menu-select.module.css";

export type MenuOption = {
  value: string;
  label: string;
  disabled?: boolean;
  badge?: string;
};

export function MenuSelect({
  value,
  options,
  onChange,
  ariaLabel,
  compact,
  placement = "up",
  name,
  disabled,
  block,
}: {
  value: string;
  options: MenuOption[];
  onChange: (value: string) => void;
  ariaLabel: string;
  compact?: boolean;
  placement?: "up" | "down";
  name?: string;
  disabled?: boolean;
  block?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const selected = options.find((option) => option.value === value) ?? options.find((option) => !option.disabled) ?? options[0];

  useEffect(() => {
    if (!open) return;
    function onPointer(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  return (
    <div
      className={[
        styles.root,
        compact ? styles.compact : "",
        block ? styles.block : "",
        disabled ? styles.disabled : "",
      ]
        .filter(Boolean)
        .join(" ")}
      ref={rootRef}
    >
      {name ? <input type="hidden" name={name} value={value} /> : null}
      <button
        type="button"
        className={styles.trigger}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
      >
        <span className={styles.triggerLabel}>{selected?.label ?? "Select"}</span>
        <HugeiconsIcon icon={ArrowDown01Icon} size={compact ? 12 : 14} />
      </button>
      {open && !disabled && (
        <ul
          className={`${styles.menu} ${placement === "down" ? styles.menuDown : styles.menuUp}`}
          id={listId}
          role="listbox"
        >
          {options.map((option) => (
            <li key={option.value} role="option" aria-selected={option.value === value} aria-disabled={option.disabled}>
              <button
                type="button"
                className={`${styles.option} ${option.value === value ? styles.optionOn : ""} ${option.disabled ? styles.optionDisabled : ""}`}
                disabled={option.disabled}
                onClick={() => {
                  if (option.disabled) return;
                  onChange(option.value);
                  setOpen(false);
                }}
              >
                <span className={styles.optionLabel}>{option.label}</span>
                {option.badge ? <span className={styles.optionBadge}>{option.badge}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
