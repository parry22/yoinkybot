/**
 * Content moderation gate. Deterministic (doctrine: code decides, not the model),
 * fast, and free - a lexicon of clearly pornographic / sexually explicit terms and
 * abusive slurs, matched on word boundaries against a lightly normalized copy of
 * the text. Any hit means the input is rejected with a single, consistent
 * "against platform guidelines" pushback.
 *
 * This is intentionally conservative: it targets unambiguous explicit/abusive
 * content (what the platform guidelines forbid), not mild profanity in passing,
 * so a founder writing "this shit is hard" isn't blocked while genuine slurs and
 * pornographic content are. Word boundaries avoid the Scunthorpe problem.
 *
 * Applied to every USER-supplied free-text choke point (chat/voice/Telegram via
 * converseWithUser, draft topics, ICP fields, profile fields, scheduled posts) so
 * nothing explicit or abusive lands on the platform or feeds a generated post.
 */

export class ModerationError extends Error {
  constructor(public reason: string = MODERATION_MESSAGE) {
    super(reason);
    this.name = "ModerationError";
  }
}

/** Yoinky's own voice (lowercase, casual); web surfaces render it verbatim. */
export const MODERATION_MESSAGE =
  "can't run with that, it crosses yoinky's content guidelines. this platform stays clean and professional, no explicit or abusive language. reword it and try again.";

// Unambiguous sexual/pornographic terms. Word-boundary matched; multi-word
// phrases are matched as-is. Keep this list explicit-only, not mild.
const SEXUAL_TERMS = [
  "porn",
  "pornography",
  "pornographic",
  "xxx",
  "hardcore sex",
  "blowjob",
  "blow job",
  "handjob",
  "creampie",
  "cumshot",
  "cum shot",
  "deepthroat",
  "deep throat",
  "gangbang",
  "bukkake",
  "anal sex",
  "oral sex",
  "cunnilingus",
  "fellatio",
  "masturbate",
  "masturbation",
  "dildo",
  "buttplug",
  "butt plug",
  "nsfw",
  "onlyfans",
  "camgirl",
  "escort service",
  "nude pics",
  "nudes",
  "sexting",
  "erotica",
  "hentai",
  "milf",
  "bdsm",
];

// Abusive slurs + hostile-intent profanity. Word-boundary matched.
const ABUSIVE_TERMS = [
  "faggot",
  "fag",
  "nigger",
  "nigga",
  "retard",
  "retarded",
  "cunt",
  "whore",
  "slut",
  "spastic",
  "tranny",
  "kike",
  "chink",
  "spic",
  "wetback",
  "coon",
  "paki",
  "dyke",
  "gook",
  "beaner",
  "kill yourself",
  "kys",
  "molest",
  "rapist",
];

const boundary = (terms: string[]): RegExp =>
  new RegExp(`\\b(?:${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`, "i");

const SEXUAL_RE = boundary(SEXUAL_TERMS);
const ABUSIVE_RE = boundary(ABUSIVE_TERMS);

/** Lowercase and collapse 3+ repeated chars ("fuuuck" → "fuuck") to blunt trivial evasion. */
function normalize(text: string): string {
  return text.toLowerCase().replace(/(.)\1{2,}/g, "$1$1");
}

export interface ModerationResult {
  ok: boolean;
  category?: "sexual" | "abusive";
}

export function moderateText(text: string): ModerationResult {
  if (!text) return { ok: true };
  const t = normalize(text);
  if (SEXUAL_RE.test(t)) return { ok: false, category: "sexual" };
  if (ABUSIVE_RE.test(t)) return { ok: false, category: "abusive" };
  return { ok: true };
}

/** Throw ModerationError when the text violates guidelines. For structured-input
 *  choke points that don't have a natural inline-reply path. */
export function assertClean(text: string): void {
  if (!moderateText(text).ok) throw new ModerationError();
}
