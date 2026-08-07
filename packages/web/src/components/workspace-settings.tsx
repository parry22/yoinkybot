"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import type { ExpertView, WorkspaceAdminView, WorkspaceRole } from "@yoink/backend/web";
import { MenuSelect } from "./menu-select";
import styles from "./workspace-settings.module.css";

const ROLES: WorkspaceRole[] = ["admin", "strategist", "editor", "contributor", "viewer"];

const OBJECTIVES = [
  ["category_awareness", "Category awareness"],
  ["founder_authority", "Founder authority"],
  ["inbound_pipeline", "Inbound pipeline"],
  ["product_adoption", "Product adoption"],
  ["developer_adoption", "Developer adoption"],
  ["customer_education", "Customer education"],
  ["sales_enablement", "Sales enablement"],
  ["recruiting", "Recruiting"],
  ["fundraising", "Fundraising"],
] as const;

const EXPERT_TYPES = [
  ["founder", "Founder"],
  ["executive", "Executive"],
  ["product", "Product"],
  ["engineering", "Engineering"],
  ["sales", "Sales"],
  ["customer_success", "Customer success"],
  ["marketing", "Marketing"],
  ["external_expert", "External expert"],
  ["other", "Other"],
] as const;

const PERMISSIONS = [
  ["public", "Public"],
  ["internal", "Internal"],
  ["restricted", "Restricted"],
  ["confidential", "Confidential"],
  ["never_use_for_generation", "Never use for generation"],
] as const;

const SOURCE_STATUSES = [
  ["active", "Active"],
  ["paused", "Paused"],
  ["archived", "Archived"],
] as const;

const formatDate = (value: string) =>
  new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(value));

function optionsFrom(pairs: ReadonlyArray<readonly [string, string]>) {
  return pairs.map(([value, label]) => ({ value, label }));
}

export function WorkspaceSettings({ initial }: { initial: WorkspaceAdminView }) {
  const [data, setData] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [objectiveKey, setObjectiveKey] = useState(data.primaryObjectiveKey ?? "category_awareness");
  const [memberRole, setMemberRole] = useState<WorkspaceRole>("contributor");
  const [expertType, setExpertType] = useState("product");

  const canAdmin = ["owner", "admin"].includes(data.role);
  const canStrategize = ["owner", "admin", "strategist"].includes(data.role);

  const roleOptions = useMemo(
    () =>
      ROLES.filter((role) => data.role === "owner" || role !== "admin").map((role) => ({
        value: role,
        label: role.charAt(0).toUpperCase() + role.slice(1),
      })),
    [data.role],
  );

  async function post(body: Record<string, unknown>) {
    setBusy(true);
    setError("");
    setSaved("");
    const response = await fetch("/api/workspace-settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = (await response.json().catch(() => ({}))) as { error?: string; expert?: ExpertView };
    setBusy(false);
    if (!response.ok) {
      setError(result.error ?? "Could not update workspace.");
      return null;
    }
    setSaved("Saved");
    return result;
  }

  async function toggle() {
    const enabled = !data.telegramDelivery;
    if (await post({ action: "telegram", enabled })) {
      setData((current) => ({ ...current, telegramDelivery: enabled }));
    }
  }

  async function saveProfile(form: FormData) {
    if (
      await post({
        action: "profile",
        description: form.get("description"),
        industry: form.get("industry"),
        website: form.get("website"),
        primaryObjective: form.get("primaryObjective"),
        primaryObjectiveKey: objectiveKey,
      })
    ) {
      setData((current) => ({
        ...current,
        description: String(form.get("description") || "") || null,
        industry: String(form.get("industry") || "") || null,
        website: String(form.get("website") || "") || null,
        primaryObjective: String(form.get("primaryObjective") || "") || null,
        primaryObjectiveKey: objectiveKey || null,
      }));
    }
  }

  async function addMember(form: FormData) {
    if (await post({ action: "add_member", email: String(form.get("email")), role: memberRole })) {
      location.reload();
    }
  }

  async function addExpert(form: FormData) {
    const result = await post({
      action: "add_expert",
      name: String(form.get("name")),
      title: String(form.get("title")),
      expertType,
      isPublicVoice: form.get("isPublicVoice") === "on",
    });
    if (result?.expert) {
      setData((current) => ({ ...current, experts: [result.expert!, ...current.experts] }));
    }
  }

  async function remove(form: FormData) {
    if (await post({ action: "delete", confirmation: String(form.get("confirmation")) })) {
      location.href = "/app";
    }
  }

  async function changeRole(targetUserId: string, role: WorkspaceRole) {
    if (await post({ action: "member_role", userId: targetUserId, role })) {
      setData((current) => ({
        ...current,
        members: current.members.map((member) =>
          member.userId === targetUserId ? { ...member, role } : member,
        ),
      }));
    }
  }

  async function updateSource(sourceId: string, permissionLevel: string, status: string) {
    if (await post({ action: "source", sourceId, permissionLevel, status })) {
      setData((current) => ({
        ...current,
        sources: current.sources.map((source) =>
          source.id === sourceId ? { ...source, permissionLevel, status } : source,
        ),
      }));
    }
  }

  return (
    <div className={styles.root}>
      <header className={styles.workspaceHead}>
        <div>
          <strong>{data.name}</strong>
          <span>
            {data.organizationName} · {data.workspaceType} workspace
          </span>
        </div>
        <b>{data.role}</b>
      </header>

      {error && <div className={styles.error}>{error}</div>}
      {saved && <div className={styles.saved}>{saved}</div>}

      <section className={styles.card}>
        <div className={styles.cardHead}>
          <div>
            <h3>Workspace profile</h3>
            <p>This stable context guides narrative and brief generation.</p>
          </div>
        </div>
        <form className={styles.profileForm} action={(form) => void saveProfile(form)}>
          <label>
            <span>Primary objective</span>
            <MenuSelect
              block
              placement="down"
              ariaLabel="Primary objective"
              value={objectiveKey}
              options={optionsFrom(OBJECTIVES)}
              onChange={setObjectiveKey}
              disabled={!canStrategize || busy}
            />
          </label>
          <label>
            <span>Industry</span>
            <input name="industry" defaultValue={data.industry ?? ""} placeholder="B2B software" />
          </label>
          <label className={styles.full}>
            <span>Objective detail</span>
            <input
              name="primaryObjective"
              defaultValue={data.primaryObjective ?? ""}
              placeholder="The business outcome this narrative should move"
            />
          </label>
          <label className={styles.full}>
            <span>Description</span>
            <textarea
              name="description"
              defaultValue={data.description ?? ""}
              rows={3}
              placeholder="What the company does and for whom"
            />
          </label>
          <label className={styles.full}>
            <span>Website</span>
            <input
              name="website"
              type="url"
              defaultValue={data.website ?? ""}
              placeholder="https://company.com"
            />
          </label>
          {canStrategize && (
            <button className="btnGhost" disabled={busy}>
              Save workspace profile
            </button>
          )}
        </form>
      </section>

      <div className={styles.twoColumn}>
        <section className={styles.card}>
          <div className={styles.cardHead}>
            <div>
              <h3>Members and roles</h3>
              <p>Workspace access is checked on every read and write.</p>
            </div>
            <b>{data.members.length}</b>
          </div>
          {data.members.map((member) => (
            <div key={member.userId} className={styles.row}>
              <div>
                <strong>{member.email ?? "Account"}</strong>
                <span>Joined {formatDate(member.joinedAt)}</span>
              </div>
              {canAdmin && member.role !== "owner" ? (
                <MenuSelect
                  ariaLabel={`Role for ${member.email ?? "member"}`}
                  placement="down"
                  value={member.role}
                  options={roleOptions}
                  disabled={busy}
                  onChange={(value) => void changeRole(member.userId, value as WorkspaceRole)}
                />
              ) : (
                <b>{member.role}</b>
              )}
            </div>
          ))}
          {canAdmin && (
            <form action={(form) => void addMember(form)} className={styles.inlineForm}>
              <input name="email" type="email" placeholder="Existing user's email" required />
              <MenuSelect
                ariaLabel="New member role"
                placement="down"
                value={memberRole}
                options={roleOptions}
                disabled={busy}
                onChange={(value) => setMemberRole(value as WorkspaceRole)}
              />
              <button className="btnGhost" disabled={busy}>
                Add member
              </button>
            </form>
          )}
        </section>

        <section className={styles.card}>
          <div className={styles.cardHead}>
            <div>
              <h3>Experts and public voices</h3>
              <p>Each expert keeps an independent voice profile.</p>
            </div>
            <b>{data.experts.length}</b>
          </div>
          {data.experts.map((expert) => (
            <div key={expert.id} className={styles.row}>
              <div>
                <strong>{expert.name}</strong>
                <span>{expert.title ?? expert.expertType.replaceAll("_", " ")}</span>
              </div>
              <div className={styles.badges}>
                {expert.isDefault && <b>Default</b>}
                {expert.isPublicVoice && <b>Public voice</b>}
              </div>
            </div>
          ))}
          {canStrategize && (
            <form action={(form) => void addExpert(form)} className={styles.expertForm}>
              <input name="name" placeholder="Expert name" required />
              <input name="title" placeholder="Title" />
              <MenuSelect
                ariaLabel="Expert type"
                placement="down"
                value={expertType}
                options={optionsFrom(EXPERT_TYPES)}
                disabled={busy}
                onChange={setExpertType}
              />
              <label className={styles.check}>
                <input name="isPublicVoice" type="checkbox" /> Public voice
              </label>
              <button className="btnGhost" disabled={busy}>
                Add expert
              </button>
            </form>
          )}
        </section>
      </div>

      <section className={styles.card}>
        <div className={styles.cardHead}>
          <div>
            <h3>Sources and permissions</h3>
            <p>Changing a source permission propagates to its captures and extracted knowledge.</p>
          </div>
          <b>{data.sources.length}</b>
        </div>
        {data.sources.length === 0 ? (
          <div className={styles.emptyBlock}>
            <p className={styles.empty}>No company sources yet.</p>
            <div className={styles.emptyActions}>
              <Link href="/app/knowledge" className="btnGhost">
                Add in Knowledge
              </Link>
              <Link href="/app/integrations" className="btnGhost">
                From Integrations
              </Link>
            </div>
          </div>
        ) : (
          data.sources.map((source) => (
            <div key={source.id} className={styles.sourceRow}>
              <div>
                <strong>{source.name}</strong>
                <span>
                  {source.sourceType.replaceAll("_", " ")}
                  {source.lastIngestedAt ? ` · ${formatDate(source.lastIngestedAt)}` : ""}
                </span>
              </div>
              <MenuSelect
                block
                ariaLabel={`Permission for ${source.name}`}
                placement="down"
                value={source.permissionLevel}
                options={optionsFrom(PERMISSIONS)}
                disabled={!canAdmin || busy}
                onChange={(value) => void updateSource(source.id, value, source.status)}
              />
              <MenuSelect
                block
                ariaLabel={`Status for ${source.name}`}
                placement="down"
                value={source.status}
                options={optionsFrom(SOURCE_STATUSES)}
                disabled={!canAdmin || busy}
                onChange={(value) => void updateSource(source.id, source.permissionLevel, value)}
              />
            </div>
          ))
        )}
      </section>

      <section className={styles.card}>
        <div className={styles.cardHead}>
          <div>
            <h3>Telegram delivery</h3>
            <p>
              Company knowledge stays out of Telegram unless an admin enables it. Confidential and
              restricted items remain excluded.
            </p>
          </div>
          <button
            type="button"
            className={`${styles.toggle} ${data.telegramDelivery ? styles.toggleOn : ""}`}
            aria-pressed={data.telegramDelivery}
            disabled={!canAdmin || busy}
            onClick={() => void toggle()}
          >
            <i />
          </button>
        </div>
      </section>

      {canAdmin && (
        <section className={styles.card}>
          <div className={styles.cardHead}>
            <div>
              <h3>Data controls</h3>
              <p>Export the complete workspace graph or safely delete a company workspace.</p>
            </div>
          </div>
          <div className={styles.dataActions}>
            <a className="btnGhost" href="/api/workspace-settings">
              Export workspace data
            </a>
            {data.workspaceType === "company" && data.role === "owner" && (
              <form action={(form) => void remove(form)}>
                <input name="confirmation" placeholder={`Type ${data.name} to delete`} required />
                <button className="btnGhost" disabled={busy}>
                  Delete workspace
                </button>
              </form>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
