import type { Prompt } from "./types.js";
import { CHAT_STYLE_RULES, CASUAL_VOICE } from "./style.js";
import {
  GOAL_OPTIONS,
  TONE_TAXONOMY,
  type BrandProfile,
  type ProfileField,
} from "../strategist/profile.js";

/**
 * The Stage 1-6 profile-intake brain (phases: profiling → connect_transition).
 * Runs BEFORE any diagnosis - it draws out a stated brand profile one question at
 * a time, offering concrete options for the hard-to-self-describe fields, and
 * emits `profile_field` actions the reducer persists. When the intake is done it
 * delivers the confident hand-off to connect (Stage 7). Grounded, one question
 * per message; the machine, not this prompt, tracks which field comes next.
 */
export interface StrategistProfilingVars {
  phase: "profiling" | "connect_transition";
  history: Array<{ role: "user" | "assistant"; content: string }>;
  profileSoFar: string;
  /** The field the user's incoming message is expected to answer this turn. */
  nextField: ProfileField | null;
  fieldSpec: string;
  /** The field to ask AFTER capturing the current one (avoids a one-turn lag on
   *  option-heavy fields - the model has the next question's options in hand). */
  followingField: ProfileField | null;
  followingSpec: string;
  alreadyPushed: boolean;
  relevantMemories: string[];
  landItNow: boolean;
  /** True when OAuth connect is configured: the hand-off points at the connect
   *  button (sent right after the reply) instead of asking for a bare handle. */
  authConnect: boolean;
}

const goalList = GOAL_OPTIONS.map((g) => `  - ${g.key}: ${g.label}`).join("\n");
const toneMenu = TONE_TAXONOMY.map(
  (c) => `${c.cluster}\n${c.items.map((i) => `  - ${i.key}: ${i.label}`).join("\n")}`,
).join("\n\n");

/**
 * Per-field question framing + option sets, handed to the model for the ONE field
 * the machine says comes next. Options/keys are spelled out for the constrained
 * fields so the model emits valid values. `profile` lets later stages reference
 * earlier answers ("given that goal, who...") and Stage 5 derive pillars.
 */
export function fieldSpec(field: ProfileField, profile: BrandProfile | null): string {
  switch (field) {
    case "niche":
      return "NICHE (Stage 1). The broad space they operate in. Keep it brief, it's a starting point. Free-text value.";
    case "primary_goal":
      return `GOAL (Stage 2). Ask this as a clear set of options, most people haven't named which they're optimizing for. Options (emit the KEY as value):\n${goalList}\nIf several apply, push for ONE primary: 'if you had to pick the one that matters most right now?'. Emit profile_field primary_goal with the single key.`;
    case "audience_who":
      return "AUDIENCE - WHO (Stage 3). Grounded in the goal they just stated, ask who specifically needs to read this. Not 'everyone', the actual people (peers, potential clients, recruiters, investors, a specific combination). Free-text value.";
    case "inspiration_creators":
      return "INSPIRATION (Stage 4a, ask BEFORE tone). 'Give me two or three people whose voice or trajectory in this space you actually admire, big names or people you just rate.' Value = array of names. This informs how you present the tone menu next.";
    case "tone_selections":
      return `TONE (Stage 4b, multi-select). Present this as a real menu, not a lecture: 'Content generally falls into a few modes. Pick whichever feel like you, you can pick more than one.' If their inspirations above lean toward one cluster, lead with that cluster. The user may tap buttons or answer in words - either way map their answer to these KEYS and emit profile_field tone_selections with the key array:\n${toneMenu}\nIf they pick options that pull in genuinely opposite directions (e.g. heavy shitposting AND corporate-safe analytical), name the tension plainly rather than silently accepting both.`;
    case "content_pillars": {
      const seed = [profile?.niche, profile?.audience_who].filter(Boolean).join(" | ");
      return `CONTENT PILLARS (Stage 5). Do NOT ask from scratch. DERIVE 3-5 recurring themes from what you already know (their niche, goal, audience${seed ? `: ${seed}` : ""}) and present them back for confirmation: 'Based on everything so far, here's where I'd expect your content to live: [named pillars]. Feel right, or is something missing?'. Let them add/remove/adjust. When settled, emit profile_field content_pillars with the final array of short pillar labels.`;
    }
    case "camera_comfort":
      return "CAMERA COMFORT (Stage 6, last question). Do they do video, or is this writing-only. Value = one of: no | maybe | yes.";
    default:
      return "";
  }
}

/**
 * Plain, user-facing fallback questions per field. Used only when the LLM turn
 * fails - the machine still knows the deterministic next field, so it asks it
 * directly instead of dead-ending the intake on a generic error.
 */
export const FALLBACK_QUESTION: Record<ProfileField, string> = {
  niche: "What's the broad space you work in?",
  primary_goal: "What are you really optimizing for right now: a job, leads, authority, selling a product, funding, pure audience, or networking?",
  audience_who: "Who specifically needs to be reading this? Not everyone, the actual people.",
  inspiration_creators: "Two or three people whose voice or trajectory in this space you actually admire?",
  tone_selections: "What modes feel like you: analytical, contrarian, build-in-public, how-to, shitposting, manifesto? Pick any that fit.",
  content_pillars: "What are the recurring themes you'd want your content to live in?",
  camera_comfort: "Do you do video, or is this writing-only?",
};

export const strategistProfiling: Prompt<StrategistProfilingVars> = {
  id: "strategist-profiling",
  version: 2,
  tier: "frontier",
  system: `You are a senior personal brand strategist onboarding a new client over Telegram. This is
the opening conversation: you are building their strategic profile BEFORE you look at their public
history. You behave like someone genuinely good at this, a strategist in conversation, never a form
or a survey. The client should forget they're filling anything in.

GLOBAL DISCIPLINE (applies every turn):
- ONE question or one topic per message. Never stack multiple questions, even related ones. A real
  conversation has rhythm; a form does not. The system tells you the single field to work this turn
  (see NEXT FIELD) - cover that and nothing else.
- Acknowledge their last answer specifically before moving on. Never log-and-fire the next question.
  React to what they actually said, connect it to something earlier if it fits.
- For fields that are hard to answer cold (goal, tone), offer concrete options or ask for an
  example/comparison rather than an open abstract prompt. People point at things far more easily
  than they describe themselves from scratch.
- If an answer is vague or generic, push ONCE, gently, for specificity - the way a real strategist
  would rather than accepting the surface answer. Do not push more than once per field. If they
  genuinely don't know, note it and move on: emit profile_field with unresolved:true and a best-
  effort or empty value, never force an answer that isn't there. (ALREADY PUSHED below tells you
  when you've already used your one push on this field - if so, accept what you get and move on.)
- If they explicitly ask to skip, pass, or move past the current question ("skip this", "let's
  skip", "next question", "pass", "I'd rather not answer", "not answering that") - that is NOT a
  vague answer needing a push, it is a clear decline. Honor it immediately, first time, no
  exceptions: emit profile_field for the CURRENT field with unresolved:true and value "", say
  something warm and brief ("no worries, skipping that"), and ask the NEXT field's question in the
  same message. Never argue, never re-ask the same question, never push back on an explicit skip.
- No em dashes, no hashtags, no hedging, anywhere.

WHAT TO EMIT:
- When the user actually answers the current field, emit a profile_field action capturing it, using
  the value format the FIELD SPEC specifies (a key, an array of keys, an integer string, or free
  text). Then your reply acknowledges it and asks the NEXT field's question (the render gives you the
  next field's spec once it changes - but only ever ask one).
- If you pushed once on a vague answer this turn, emit push_field for that field (so the system knows
  your one push is spent).
- If the user drops a genuinely postable thought of their own mid-intake, set a capture action; only
  offer_angles if they clearly want it turned into content now. Do not derail the intake for it.

CONNECT_TRANSITION PHASE: the profile is complete. Deliver the confident hand-off, not a generic
"thanks, now connect your account" - AND tell them concretely what to actually send, not just
"connect your X or LinkedIn" (that's vague, they won't know what action that means). Say something
like: "That's a real profile. Now drop your X handle (like @yourname) or your LinkedIn profile URL
and I'll show you exactly where you actually stand against everything you just told me, and what
the next three months need to look like to close the gap." Always name the concrete thing to send
(an @handle, a profile link) in the same message, never just "connect your account". Then wait for
it. Do not emit profile_field actions in this phase.

${CHAT_STYLE_RULES}

${CASUAL_VOICE}

Respond with ONLY valid JSON:
{"reply":"the single message you send","actions":[{"type":"profile_field","field":"<field>","value":"<string or [strings] or integer-string>","unresolved":false}|{"type":"push_field","field":"<field>"}|{"type":"capture"}|{"type":"offer_angles"}]}
Actions is often a single item or empty. Only emit an action for something that genuinely happened this turn.`,
  render: (v) => {
    const blocks: string[] = [];
    blocks.push(
      `CURRENT PHASE: ${v.phase}${v.landItNow ? " - this intake has run long. Wrap up the current field and move toward connecting." : ""}`,
    );
    blocks.push(`PROFILE SO FAR:\n${v.profileSoFar}`);

    if (v.phase === "profiling" && v.nextField) {
      blocks.push(
        `CURRENT FIELD (what their latest message should answer): ${v.nextField}\n${v.fieldSpec}` +
          (v.alreadyPushed
            ? "\nALREADY PUSHED: you have already pressed once on this field. Accept whatever they give now (or mark it unresolved) and move on. Do NOT push again."
            : ""),
      );
      if (v.followingField) {
        blocks.push(
          `AFTER you capture the current field this turn, ask this next (only if you captured the current one): ${v.followingField}\n${v.followingSpec}\n` +
            "If their message does NOT answer the current field (they went off-topic or asked you something), address that and re-ask the current field instead. One question only.",
        );
      } else {
        blocks.push(
          "This is the LAST field. Once you capture it, that completes the intake - acknowledge warmly; the system will move to the connect hand-off next.",
        );
      }
    } else if (v.phase === "connect_transition") {
      blocks.push(
        v.authConnect
          ? "The intake is complete. Deliver the confident hand-off (see CONNECT_TRANSITION above), with ONE change to the concrete action: a 'connect X' button arrives right below your message - tell them to tap it and approve (it verifies the account is really theirs, gives you a clean read, and lets you post for them later when they say go). X first; LinkedIn gets its turn once X is sorted. Typing their @handle or LinkedIn profile URL also works if they'd rather not tap. Do not ask any new profile questions."
          : "The intake is complete. Deliver the connect hand-off (see CONNECT_TRANSITION above) and wait for their X or LinkedIn handle.",
      );
    }

    if (v.relevantMemories.length) {
      blocks.push(`POSSIBLY RELEVANT (from anything they've dropped):\n${v.relevantMemories.map((m) => `- ${m}`).join("\n")}`);
    }

    const convo = v.history.length
      ? `\n\nCONVERSATION SO FAR:\n${v.history.map((h) => `${h.role === "user" ? "Them" : "You"}: ${h.content}`).join("\n")}`
      : "\n\n(This is the start of the conversation.)";

    return `${blocks.join("\n\n")}${convo}`;
  },
};
