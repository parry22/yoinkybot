"use client";

import { useEffect, useState } from "react";
import styles from "./theme-toggle.module.css";

/** Light/dark switch - lives in Settings. Persists to localStorage and stamps
 *  data-theme on <html> (read by globals.css, initialized pre-paint in layout.tsx). */
export function ThemeToggle() {
  const [theme, setTheme] = useState<"light" | "dark">("light");

  useEffect(() => {
    const stored = (localStorage.getItem("yoink-theme") as "light" | "dark" | null) ?? null;
    const initial = stored ?? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    setTheme(initial);
  }, []);

  function toggle() {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem("yoink-theme", next);
  }

  return (
    <div className={styles.row}>
      <div>
        <div className={styles.label}>Dark mode</div>
        <div className={styles.sub}>{theme === "dark" ? "On" : "Off"} - matches your system by default.</div>
      </div>
      <button
        type="button"
        className={`${styles.switch} ${theme === "dark" ? styles.switchOn : ""}`}
        onClick={toggle}
        aria-label="Toggle dark mode"
      >
        <span className={styles.knob} />
      </button>
    </div>
  );
}
