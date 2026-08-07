"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import styles from "./workspace-setup.module.css";

export function CreateWorkspaceForm() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const form = new FormData(event.currentTarget);
    const response = await fetch("/api/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: form.get("name"),
        description: form.get("description"),
        primaryObjective: form.get("primaryObjective"),
        founderName: form.get("founderName"),
        founderTitle: form.get("founderTitle"),
      }),
    });
    const data = (await response.json().catch(() => ({}))) as { error?: string };
    if (!response.ok) {
      setError(data.error ?? "Could not create workspace.");
      setBusy(false);
      return;
    }
    router.push("/app");
    router.refresh();
  }

  return (
    <form className={styles.form} onSubmit={submit}>
      <div className={styles.fieldGroup}>
        <label htmlFor="workspace-name">Company or brand name</label>
        <input id="workspace-name" name="name" className="field" minLength={2} maxLength={100} required autoFocus />
      </div>
      <div className={styles.fieldGroup}>
        <label htmlFor="workspace-description">What does the company do?</label>
        <textarea id="workspace-description" name="description" maxLength={500} rows={3} />
      </div>
      <div className={styles.fieldGroup}>
        <label htmlFor="workspace-objective">Primary narrative objective</label>
        <input
          id="workspace-objective"
          name="primaryObjective"
          className="field"
          maxLength={240}
          placeholder="For example, create category demand with technical founders"
        />
      </div>
      <div className={styles.twoColumn}>
        <div className={styles.fieldGroup}>
          <label htmlFor="founder-name">Founder's name</label>
          <input id="founder-name" name="founderName" className="field" maxLength={100} />
        </div>
        <div className={styles.fieldGroup}>
          <label htmlFor="founder-title">Title</label>
          <input id="founder-title" name="founderTitle" className="field" maxLength={100} placeholder="Founder and CEO" />
        </div>
      </div>
      {error && <p className={styles.error}>{error}</p>}
      <div className={styles.actions}>
        <button type="button" className="btnGhost" onClick={() => router.back()} disabled={busy}>Cancel</button>
        <button type="submit" className="btnPrimary" disabled={busy}>{busy ? "Creating…" : "Create workspace"}</button>
      </div>
    </form>
  );
}

