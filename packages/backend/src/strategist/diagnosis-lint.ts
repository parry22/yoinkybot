import type { Diagnosis } from "./diagnosis.js";

/**
 * Deterministic spec-compliance gate for a generated diagnosis. This is the
 * safety net between the model and the user: language rules (no em dashes,
 * hashtags, hedging) and groundedness rules (dated evidence) are checkable
 * without another LLM, so check them. Violations feed one corrective retry.
 */

export interface Violation {
  path: string;
  rule: string;
  detail: string;
}

/** Hedges are flagged only in the strategist's own prose (read/headline fields) — quoted user posts may legitimately contain "I think". */
const HEDGES = ["it seems like", "it seems that", "i think you", "just wanted to", "you might have", "perhaps you", "it appears"];

const DATE_TOKEN = /\b20\d{2}\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i;

function sentenceCount(text: string): number {
  return text.split(/[.!?]+/).filter((s) => s.trim().length > 1).length;
}

export function lintDiagnosis(d: Diagnosis): Violation[] {
  const v: Violation[] = [];

  const prose: Array<[string, string]> = [
    ["headline", d.headline],
    ["intellectual_fingerprint.read", d.intellectual_fingerprint.read],
    ["voice_signature.read", d.voice_signature.read],
    ["voice_signature.drift", d.voice_signature.drift],
    ["outside_in_gap.read", d.outside_in_gap.read],
    ...d.consistency_audit.map((c, i) => [`consistency_audit[${i}].why_interesting`, c.why_interesting] as [string, string]),
  ];
  const everything: Array<[string, string]> = [
    ...prose,
    ...d.intellectual_fingerprint.owned_positions.map((p, i) => [`owned_positions[${i}]`, p] as [string, string]),
    ...d.intellectual_fingerprint.latent_beliefs.map((p, i) => [`latent_beliefs[${i}]`, p] as [string, string]),
    ...d.outside_in_gap.missed_swings.map((s, i) => [`missed_swings[${i}]`, s] as [string, string]),
    ...d.consistency_audit.map((c, i) => [`consistency_audit[${i}].tension`, c.tension] as [string, string]),
    ...d.unsaid_patterns.flatMap(
      (u, i) =>
        [
          [`unsaid_patterns[${i}].idea`, u.idea],
          [`unsaid_patterns[${i}].evidence`, u.evidence],
        ] as Array<[string, string]>,
    ),
  ];

  for (const [path, text] of everything) {
    if (text.includes("—")) v.push({ path, rule: "no-em-dash", detail: "contains an em dash" });
    if (/(^|\s)#\w/.test(text)) v.push({ path, rule: "no-hashtag", detail: "contains a hashtag" });
  }
  for (const [path, text] of prose) {
    const lower = text.toLowerCase();
    const hit = HEDGES.find((h) => lower.includes(h));
    if (hit) v.push({ path, rule: "no-hedging", detail: `hedging phrase "${hit}"` });
  }

  if (sentenceCount(d.headline) > 3 || d.headline.length > 420) {
    v.push({ path: "headline", rule: "headline-too-long", detail: "headline must be 2-3 sentences" });
  }

  // Groundedness: recurrence claims need dates attached to the evidence.
  d.intellectual_fingerprint.owned_positions.forEach((p, i) => {
    if (!DATE_TOKEN.test(p)) {
      v.push({ path: `owned_positions[${i}]`, rule: "needs-date", detail: "owned position lacks an approximate date" });
    }
  });
  d.consistency_audit.forEach((c, i) => {
    if (!DATE_TOKEN.test(c.tension)) {
      v.push({ path: `consistency_audit[${i}].tension`, rule: "needs-date", detail: "contradiction lacks the dates of both statements" });
    }
  });
  d.unsaid_patterns.forEach((u, i) => {
    if (u.evidence.trim().length < 15) {
      v.push({ path: `unsaid_patterns[${i}].evidence`, rule: "needs-evidence", detail: "unsaid pattern has no real evidence — cut it rather than force it" });
    }
  });

  return v;
}

/** Format violations as the corrective instruction for one retry. */
export function violationInstruction(violations: Violation[]): string {
  return (
    "Your previous diagnosis violated the spec. Fix EXACTLY these and change nothing else:\n" +
    violations.map((x) => `- ${x.path}: ${x.detail} [${x.rule}]`).join("\n") +
    "\nRespond with the corrected, complete JSON only."
  );
}
