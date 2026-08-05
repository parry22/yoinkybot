import { query, queryOne } from "../db/pool.js";
import { ALL_TONE_KEYS, SINCERITY_VALUES, MOTIVE_VALUES } from "./classification.js";

/**
 * Per-user correction log + calibration. Corrections are a permanent training
 * signal (memory/classification.ts's predicates stay conservative by default;
 * a correction is the one thing allowed to shift a specific user's baseline).
 * `recordCorrection` is the single choke point both correction UI surfaces
 * (the chat tool and the resurface button) call into, so the "repeated
 * correction → one-time acknowledgment" rule lives in exactly one place.
 */

const CORRECTABLE_FIELDS = ["rhetorical_mode", "sincerity_register", "motive"] as const;
export type CorrectableField = (typeof CORRECTABLE_FIELDS)[number];

/**
 * Compact callback_data codec (Telegram caps callback_data at 64 bytes, and a
 * button needs to carry a full capture UUID PLUS field PLUS value - encoding
 * field/value as a 1-char code + an index into the field's fixed value list,
 * rather than the value's own text, keeps every button well under the limit).
 */
export const CORRECTION_FIELD_CODE: Record<CorrectableField, "m" | "s" | "o"> = {
  rhetorical_mode: "m",
  sincerity_register: "s",
  motive: "o",
};
export const CORRECTION_FIELD_BY_CODE: Record<string, CorrectableField> = {
  m: "rhetorical_mode",
  s: "sincerity_register",
  o: "motive",
};
export const CORRECTION_FIELD_VALUES: Record<CorrectableField, readonly string[]> = {
  rhetorical_mode: ALL_TONE_KEYS,
  sincerity_register: SINCERITY_VALUES,
  motive: MOTIVE_VALUES,
};

/** Encode (field, value) as "<code><index>" for a callback_data button, or
 *  null when the value isn't in that field's known list (only possible for
 *  rhetorical_mode, which isn't zod-enum-constrained) - callers fall back to
 *  applying the correction directly rather than offering an unencodable button. */
export function encodeCorrection(field: CorrectableField, value: string): string | null {
  const idx = CORRECTION_FIELD_VALUES[field].indexOf(value);
  return idx === -1 ? null : `${CORRECTION_FIELD_CODE[field]}${idx}`;
}

/** Inverse of encodeCorrection - null when the code is stale/malformed. */
export function decodeCorrection(code: string): { field: CorrectableField; value: string } | null {
  const fieldChar = code[0];
  const field = fieldChar ? CORRECTION_FIELD_BY_CODE[fieldChar] : undefined;
  if (!field) return null;
  const idx = Number(code.slice(1));
  const value = CORRECTION_FIELD_VALUES[field][idx];
  return value ? { field, value } : null;
}

/** Read this user's monthly-recalibrated note, if one exists yet. */
export async function getCalibrationNote(userId: string): Promise<string | null> {
  const row = await queryOne<{ note: string }>(
    `SELECT note FROM classification_calibration WHERE user_id = $1`,
    [userId],
  );
  return row?.note ?? null;
}

const REPEAT_WINDOW_DAYS = 30;
const REPEAT_THRESHOLD = 2;

const ACK_LINE: Record<CorrectableField, string> = {
  sincerity_register:
    "noticed i've been reading your joke posts too straight a few times now, adjusting for that going forward.",
  rhetorical_mode: "noticed i've been misreading your tone a few times now, adjusting for that going forward.",
  motive: "noticed i've been misreading why you're posting a few times now, adjusting for that going forward.",
};

export interface RecordCorrectionResult {
  /** Non-null the one turn the repeated-correction pattern first crosses
   *  threshold - the caller should deliver this line once, then never again. */
  acknowledgment: string | null;
}

/**
 * Apply a correction: update the capture's classification column, log it as a
 * permanent per-user signal, and synchronously check whether this is the 2nd+
 * correction on the same field in the last 30 days - if so (and not already
 * acknowledged), return the one-time acknowledgment line. Synchronous by
 * design, not a scheduled sweep: matches this codebase's existing detect-and-
 * notify-in-the-write-path idiom (jobs/extract.ts's belief-flip DM does the
 * same thing inline).
 */
const FIELD_LABEL: Record<CorrectableField, string> = {
  rhetorical_mode: "rhetorical mode",
  sincerity_register: "sincerity",
  motive: "motive",
};

/**
 * Pure: turn a user's raw correction rows into a short calibration note.
 * Deterministic, not an LLM paraphrase - the fact "you corrected sincerity 3x
 * toward ironic" is more honest and cheaper to produce than a model's gloss on
 * it, and this feeds directly back into the classification prompt as a fact.
 */
export function buildCalibrationNote(corrections: Array<{ field: CorrectableField; corrected_value: string }>): string | null {
  if (corrections.length === 0) return null;
  const byField = new Map<CorrectableField, Map<string, number>>();
  for (const c of corrections) {
    const counts = byField.get(c.field) ?? new Map<string, number>();
    counts.set(c.corrected_value, (counts.get(c.corrected_value) ?? 0) + 1);
    byField.set(c.field, counts);
  }
  const parts: string[] = [];
  for (const [field, counts] of byField) {
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    const [topValue, topCount] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]!;
    parts.push(
      `${FIELD_LABEL[field]} was corrected ${total} time${total === 1 ? "" : "s"} recently, most often to "${topValue}" (${topCount}x) - weight toward that when it's genuinely ambiguous.`,
    );
  }
  return parts.join(" ");
}

/**
 * Monthly recalibration: for every user with a correction in the last 30 days,
 * re-derive their calibration note from the raw log and upsert it. Correction-
 * only by design - no external research into platform-wide humor drift (that
 * would need a new integration this backend doesn't have).
 */
export async function handleMonthlyRecalibration(): Promise<void> {
  const users = await query<{ user_id: string }>(
    `SELECT DISTINCT user_id FROM classification_corrections WHERE created_at > now() - interval '30 days'`,
  );
  for (const { user_id } of users) {
    const corrections = await query<{ field: CorrectableField; corrected_value: string }>(
      `SELECT field, corrected_value FROM classification_corrections
       WHERE user_id = $1 AND created_at > now() - interval '30 days'`,
      [user_id],
    );
    const note = buildCalibrationNote(corrections);
    if (!note) continue;
    await query(
      `INSERT INTO classification_calibration (user_id, note, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (user_id) DO UPDATE SET note = $2, updated_at = now()`,
      [user_id, note],
    );
  }
}

export async function recordCorrection(
  userId: string,
  captureId: string,
  field: CorrectableField,
  correctedValue: string,
): Promise<RecordCorrectionResult> {
  // The column name is whitelisted before interpolation, never trusted from a
  // caller purely by its TS type - mirrors strategist/profile.ts's
  // upsertProfileField, since one call site resolves `field` from LLM output.
  if (!CORRECTABLE_FIELDS.includes(field)) throw new Error(`unknown correctable field: ${field}`);
  const prev = await queryOne<Record<string, string | null>>(
    `SELECT ${field} FROM captures WHERE id = $1 AND user_id = $2`,
    [captureId, userId],
  );
  await query(`UPDATE captures SET ${field} = $2 WHERE id = $1 AND user_id = $3`, [captureId, correctedValue, userId]);
  await query(
    `INSERT INTO classification_corrections (user_id, capture_id, field, previous_value, corrected_value)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, captureId, field, prev?.[field] ?? null, correctedValue],
  );

  const countRow = await queryOne<{ n: string }>(
    `SELECT count(*)::text n FROM classification_corrections
     WHERE user_id = $1 AND field = $2 AND created_at > now() - make_interval(days => $3)`,
    [userId, field, REPEAT_WINDOW_DAYS],
  );
  if (Number(countRow?.n ?? 0) < REPEAT_THRESHOLD) return { acknowledgment: null };

  const inserted = await queryOne<{ user_id: string }>(
    `INSERT INTO correction_acknowledgments (user_id, field) VALUES ($1, $2)
     ON CONFLICT (user_id, field) DO NOTHING RETURNING user_id`,
    [userId, field],
  );
  return { acknowledgment: inserted ? ACK_LINE[field] : null };
}
