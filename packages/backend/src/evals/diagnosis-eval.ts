/**
 * Golden-profile eval for the Brand Diagnosis. Requires DATABASE_URL + LLM keys.
 * Run: pnpm --filter @yoink/backend eval:diagnosis
 *
 * Seeds a synthetic founder with KNOWN structure, runs the real pipeline
 * (embeddings, reconciliation, computed evidence, diagnosis LLM, lint), then
 * asserts the diagnosis actually found what was planted:
 *  - recurring theme (distribution/audience) surfaces as an owned position
 *  - the planted venture-money contradiction is caught with dates
 *  - the counted outside-in ratio appears as numbers, not vibes
 *  - the burnout fragments (reactions only, never a post) surface as unsaid
 *  - zero (or few) lint violations
 * Cleans up after itself. Exits 1 on hard failures so it can gate a deploy.
 */
import { pool, query, queryOne } from "../db/pool.js";
import { upsertPosition } from "../memory/positions.js";
import { embedOne } from "../llm/embeddings.js";
import { toVector } from "../db/pool.js";
import { runDiagnosis } from "../strategist/diagnosis.js";
import { lintDiagnosis } from "../strategist/diagnosis-lint.js";

type Kind = "idea" | "claim" | "question" | "story" | "reaction";
type Orientation = "inside_out" | "outside_in" | "neutral";

interface SeedPost {
  text: string;
  date: string; // ISO
  kind: Kind;
  orientation: Orientation;
}

// Recurring theme A: distribution/audience (6 hits across 8 months).
// Recurring theme B: storytelling for technical founders (4 hits across 5 months).
// Planted contradiction: venture pace (2025-10 vs 2026-04).
// Unsaid pattern: creator burnout, reactions only.
const SEED: SeedPost[] = [
  { text: "Distribution is the most underrated founder skill. The best product loses to a decent one with an audience.", date: "2025-09-14", kind: "claim", orientation: "outside_in" },
  { text: "Spent the morning rewriting our onboarding emails again.", date: "2025-09-20", kind: "story", orientation: "inside_out" },
  { text: "Raising venture money forces a growth curve most founders don't actually want.", date: "2025-10-02", kind: "claim", orientation: "outside_in" },
  { text: "Shipped the new dashboard today. Proud of the team.", date: "2025-10-18", kind: "story", orientation: "inside_out" },
  { text: "Everyone obsesses over product. Almost nobody obsesses over whether anyone will hear about it.", date: "2025-11-05", kind: "claim", orientation: "outside_in" },
  { text: "Our churn dropped 2 points after the pricing change.", date: "2025-11-21", kind: "story", orientation: "inside_out" },
  { text: "Technical founders overrate polish and underrate storytelling. The demo that lands is a story, not a spec.", date: "2025-12-03", kind: "claim", orientation: "outside_in" },
  { text: "Replying to that thread on creator burnout again. Something about the incentive treadmill nobody names.", date: "2025-12-19", kind: "reaction", orientation: "outside_in" },
  { text: "We hit 1k users this week. Grateful.", date: "2026-01-08", kind: "story", orientation: "inside_out" },
  { text: "The founders who win crowded markets built an audience before they needed one.", date: "2026-01-22", kind: "claim", orientation: "outside_in" },
  { text: "Another burnout thread, another hundred creators nodding along. The pattern is structural, not personal.", date: "2026-02-04", kind: "reaction", orientation: "outside_in" },
  { text: "New integrations page is live.", date: "2026-02-15", kind: "story", orientation: "inside_out" },
  { text: "Storytelling is a moat because it compounds. Features get copied in a quarter.", date: "2026-02-27", kind: "claim", orientation: "outside_in" },
  { text: "Working on our Q2 roadmap this week.", date: "2026-03-09", kind: "story", orientation: "inside_out" },
  { text: "Your product announcement is competing with everyone's entire feed. Distribution isn't optional.", date: "2026-03-20", kind: "claim", orientation: "outside_in" },
  { text: "We're raising a Series A because venture speed is the only way to win this market.", date: "2026-04-06", kind: "claim", orientation: "inside_out" },
  { text: "Demo day prep. Slides at 2am.", date: "2026-04-18", kind: "story", orientation: "inside_out" },
  { text: "That burnout essay everyone shared misses it: the audience treadmill is a business-model problem.", date: "2026-04-25", kind: "reaction", orientation: "outside_in" },
  { text: "A good narrative makes hiring easier than any comp package. Watched it happen twice this month.", date: "2026-05-07", kind: "claim", orientation: "outside_in" },
  { text: "Audience-first isn't a growth hack, it's sequencing. Build the ear before the ask.", date: "2026-05-19", kind: "claim", orientation: "outside_in" },
  { text: "Fixed the billing bug from last week.", date: "2026-05-28", kind: "story", orientation: "inside_out" },
  { text: "Technical founders keep writing changelogs when the market wants a worldview.", date: "2026-06-04", kind: "claim", orientation: "outside_in" },
];

const PLANTED_POSITIONS: Array<{ statement: string; postIndex: number }> = [
  { statement: "Distribution matters more than product polish for founders.", postIndex: 0 },
  { statement: "Raising venture money forces a growth curve most founders don't want.", postIndex: 2 },
  { statement: "Technical founders underrate storytelling.", postIndex: 6 },
  { statement: "Founders should build an audience before they need one.", postIndex: 9 },
  // The reversal - reconciliation should supersede the 2025-10 venture position.
  { statement: "Venture speed is the only way to win my market, which is why I'm raising.", postIndex: 15 },
];

interface Check {
  name: string;
  hard: boolean;
  pass: boolean;
  detail: string;
}

async function main(): Promise<void> {
  const user = await queryOne<{ id: string }>(`INSERT INTO users (email) VALUES ($1) RETURNING id`, [
    `eval-${Date.now()}@yoink.test`,
  ]);
  const userId = user!.id;
  console.log(`seeded eval user ${userId}`);

  try {
    // Seed captures + memories with real dates, kinds, orientations, embeddings.
    const memoryIds: string[] = [];
    for (const p of SEED) {
      const cap = await queryOne<{ id: string }>(
        `INSERT INTO captures (user_id, source, raw_text, captured_at, metadata, status)
         VALUES ($1,'x_import',$2,$3,'{"published":true}','processed') RETURNING id`,
        [userId, p.text, p.date],
      );
      const emb = await embedOne(p.text, userId);
      const mem = await queryOne<{ id: string }>(
        `INSERT INTO memories (user_id, profile_id, capture_id, content, kind, orientation, created_at, embedding)
         VALUES ($1,$1,$2,$3,$4,$5,$6,$7::vector) RETURNING id`,
        [userId, cap!.id, p.text, p.kind, p.orientation, p.date, toVector(emb)],
      );
      memoryIds.push(mem!.id);
    }
    console.log(`seeded ${SEED.length} memories`);

    // Positions in chronological order - exercises live reconciliation.
    for (const p of PLANTED_POSITIONS) {
      const change = await upsertPosition(userId, p.statement, memoryIds[p.postIndex]!);
      console.log(`position "${p.statement.slice(0, 50)}…" → ${change.action}${change.replaced.length ? ` (replaced: ${change.replaced.map((r) => r.slice(0, 40)).join("; ")})` : ""}`);
    }

    const supersededCount = await queryOne<{ n: string }>(
      `SELECT count(*)::text n FROM positions WHERE user_id = $1 AND status = 'evolved'`,
      [userId],
    );

    console.log("running diagnosis…");
    const diagnosis = await runDiagnosis(userId, { deliver: false });
    if (!diagnosis) throw new Error("diagnosis returned null");
    const violations = lintDiagnosis(diagnosis);
    const all = JSON.stringify(diagnosis).toLowerCase();

    const checks: Check[] = [
      {
        name: "reconciliation superseded the planted venture reversal",
        hard: true,
        pass: Number(supersededCount?.n ?? 0) >= 1,
        detail: `${supersededCount?.n ?? 0} positions superseded`,
      },
      {
        name: "recurring distribution/audience theme surfaces as owned",
        hard: true,
        pass: diagnosis.intellectual_fingerprint.owned_positions.some((p) => /distribut|audience/i.test(p)),
        detail: diagnosis.intellectual_fingerprint.owned_positions.join(" | ").slice(0, 200),
      },
      {
        name: "storytelling theme recognized somewhere in the fingerprint",
        hard: false,
        pass: /storytell|narrative/i.test(JSON.stringify(diagnosis.intellectual_fingerprint)),
        detail: "",
      },
      {
        name: "outside-in read contains counted numbers",
        hard: true,
        pass: /\d/.test(diagnosis.outside_in_gap.read),
        detail: diagnosis.outside_in_gap.read.slice(0, 200),
      },
      {
        name: "planted venture contradiction caught",
        hard: true,
        pass: diagnosis.consistency_audit.some((c) => /ventur|rais|series a|speed/i.test(c.tension)),
        detail: diagnosis.consistency_audit.map((c) => c.tension).join(" | ").slice(0, 250),
      },
      {
        name: "burnout unsaid pattern found (reactions never became a post)",
        hard: false,
        pass: /burnout|treadmill/.test(all),
        detail: diagnosis.unsaid_patterns.map((u) => u.idea).join(" | ").slice(0, 200),
      },
      {
        name: "lint violations ≤ 2",
        hard: true,
        pass: violations.length <= 2,
        detail: violations.map((x) => `${x.path}:${x.rule}`).join(", ") || "clean",
      },
    ];

    console.log("\n══ DIAGNOSIS EVAL REPORT ══");
    console.log(`headline: ${diagnosis.headline}\n`);
    let hardFailures = 0;
    for (const c of checks) {
      const mark = c.pass ? "✓" : c.hard ? "✗ HARD FAIL" : "✗ (soft)";
      if (!c.pass && c.hard) hardFailures++;
      console.log(`${mark}  ${c.name}${c.detail ? `\n     ${c.detail}` : ""}`);
    }
    console.log(`\n${checks.filter((c) => c.pass).length}/${checks.length} checks passed, ${hardFailures} hard failure(s)`);
    process.exitCode = hardFailures > 0 ? 1 : 0;
  } finally {
    await query(`DELETE FROM users WHERE id = $1`, [userId]); // cascades everything
    await pool.end();
    console.log("cleaned up eval user");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
