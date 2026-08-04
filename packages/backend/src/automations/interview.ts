/**
 * The Auto Agent setup interview: transcript in, next question out, and an
 * automation at the end of it.
 *
 * STATELESS BY DESIGN. The whole interview is a pure function of the transcript,
 * which the client sends back each turn. That means no interview table, no
 * resumable-session bookkeeping, no half-finished rows to sweep — and re-deriving
 * the slots from scratch every turn makes a late correction ("actually, weekly")
 * work for free, where incremental state would have needed an explicit edit path.
 *
 * CODE OWNS THE STRUCTURE. Which slots exist, which one is asked next, and when
 * the interview is finished are all decided here. The model only extracts what was
 * said and phrases the question it is told to ask (prompts/automation-interview.v1).
 * Without that split, a model that likes wrapping up would build agents with no
 * angles and no hooks — the exact thing the old three-pill form got wrong.
 */
import { z } from "zod";
import { llmCall } from "../llm/gateway.js";
import { automationInterview } from "../prompts/automation-interview.v1.js";
import { casualize } from "../prompts/style.js";
import { getProfile, profileSummaryForPrompt } from "../strategist/profile.js";
import { entitlementsFor } from "../billing/entitlements.js";
import { moderateText, MODERATION_MESSAGE } from "../moderation/filter.js";
import type { SourceType, DeliveryMode, CadenceKind } from "./types.js";

export interface InterviewMessage {
  role: "user" | "assistant";
  content: string;
}

/** Everything an agent needs before it can be built. */
export interface AgentSpec {
  purpose: string | null;
  postTypes: string[];
  angles: string[];
  hooks: string[];
  source: SourceType | null;
  platform: "x" | "linkedin" | null;
  cadence: CadenceKind | null;
  delivery: DeliveryMode | null;
  name: string | null;
}

export const EMPTY_SPEC: AgentSpec = {
  purpose: null,
  postTypes: [],
  angles: [],
  hooks: [],
  source: null,
  platform: null,
  cadence: null,
  delivery: null,
  name: null,
};

/**
 * The slots, in ASK ORDER, and what each is for.
 *
 * Order is deliberate: purpose first because every later option should be shaped
 * by it, then the three that actually determine whether the writing is any good
 * (post types, angles, hooks), then the operational two. `name` is never asked —
 * it's inferred, because being interviewed about a label is a waste of a turn.
 */
const SLOTS: Array<{ key: keyof AgentSpec; brief: string }> = [
  {
    key: "purpose",
    brief:
      "what this agent is FOR — the job it does for them. Open with something better than " +
      "'what should it do?': propose a couple of jobs that fit their niche.",
  },
  {
    key: "postTypes",
    brief:
      "what SHAPE of post it should write — hot takes, teardowns, personal stories, how-tos, " +
      "threads, one-liners. Suggest the ones that fit their pillars.",
  },
  {
    key: "angles",
    brief:
      "which ANGLES/topics it may take, i.e. its lanes. Propose specific ones from their pillars " +
      "and niche, and confirm what's off-limits if that's easier for them to answer.",
  },
  {
    key: "hooks",
    brief:
      "which HOOK styles suit them — blunt claim, a number, a question, a story open, a " +
      "'nobody tells you' reveal. Name real examples in their voice.",
  },
  {
    key: "platform",
    brief: "where it should publish — X or LinkedIn. Explain that the writing will be shaped for that feed.",
  },
  {
    key: "source",
    brief:
      "where its raw material comes from: riding what's trending in their niche (trend_ride), " +
      "working the idea backlog already in their plan (unlock_backlog), or purely from the brief " +
      "they've just described (custom). Describe the choice in plain terms, never with those keys.",
  },
  {
    key: "cadence",
    brief: "how often it runs — daily, weekly, or only when they hit run.",
  },
  {
    key: "delivery",
    brief:
      "whether it asks them before anything goes out, or posts on its own. If their plan is " +
      "approval-only, state that as a fact and confirm.",
  },
];

/**
 * Brief ceiling. Larger than the old 1000 because the interview's brief is now a
 * structured four-part instruction (purpose + shapes + angles + hooks) rather than
 * one sentence the user typed — truncating it would silently drop the hook rules,
 * which is exactly the part that makes the agent's writing theirs.
 */
export const BRIEF_MAX = 2000;

const SOURCE_TYPES: SourceType[] = ["trend_ride", "unlock_backlog", "custom"];
const CADENCES: CadenceKind[] = ["daily", "weekly", "manual"];
const DELIVERIES: DeliveryMode[] = ["approval", "auto"];

const turnSchema = z.object({
  slots: z
    .object({
      purpose: z.string().nullish(),
      post_types: z.array(z.string()).nullish(),
      angles: z.array(z.string()).nullish(),
      hooks: z.array(z.string()).nullish(),
      source: z.string().nullish(),
      platform: z.string().nullish(),
      cadence: z.string().nullish(),
      delivery: z.string().nullish(),
      name: z.string().nullish(),
    })
    .catch({}),
  reply: z.string().catch(""),
  options: z.array(z.string()).catch([]),
});

const cleanList = (v: unknown): string[] => {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const raw of v) {
    const t = String(raw ?? "").trim().slice(0, 120);
    if (t && !out.includes(t)) out.push(t);
  }
  return out.slice(0, 8);
};

/** Whether a slot counts as answered. Lists need at least one entry. */
function isFilled(spec: AgentSpec, key: keyof AgentSpec): boolean {
  const v = spec[key];
  if (Array.isArray(v)) return v.length > 0;
  return v !== null && String(v).trim().length > 0;
}

/** The next thing to ask about, or null when the spec is complete. */
export function nextSlot(spec: AgentSpec): (typeof SLOTS)[number] | null {
  return SLOTS.find((s) => !isFilled(spec, s.key)) ?? null;
}

export interface InterviewTurn {
  /** What Yoinky says this turn. */
  reply: string;
  /** Tappable suggestions for the question just asked. Empty when done. */
  options: string[];
  /** Everything pinned down so far. */
  spec: AgentSpec;
  /** True once every required slot is filled — the caller then builds the agent. */
  complete: boolean;
}

/**
 * Run one interview turn against the full transcript.
 *
 * `spec` is re-derived from the transcript every time rather than threaded through,
 * so the model's extraction is always judged against the whole conversation.
 */
export async function runInterviewTurn(userId: string, messages: InterviewMessage[]): Promise<InterviewTurn> {
  // Content gate on the user's own words before they reach the model or storage.
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (lastUser && !moderateText(lastUser.content).ok) {
    return { reply: casualize(MODERATION_MESSAGE), options: [], spec: EMPTY_SPEC, complete: false };
  }

  const [profile, ent] = await Promise.all([
    getProfile(userId).catch(() => null),
    entitlementsFor(userId),
  ]);
  const approvalOnly = !ent.autoAgent;

  // Pass 1: extract from the transcript with no next-slot instruction, so we can
  // see what's known BEFORE deciding what to ask. The same call also returns a
  // reply, which is discarded — the second call writes the one we use.
  const extracted = await extract(userId, messages, EMPTY_SPEC, null, "", profile, approvalOnly);
  let spec = extracted.spec;
  // Approval-only plans can't choose hands-off, so code overrides rather than
  // letting the interview offer something the run pipeline would refuse anyway.
  if (approvalOnly) spec = { ...spec, delivery: "approval" };

  const slot = nextSlot(spec);
  if (!slot) {
    // Complete — one confirming line, no question.
    const done = await extract(userId, messages, spec, null, "", profile, approvalOnly);
    return {
      reply: casualize(done.reply || "that's everything i need — building it now."),
      options: [],
      spec,
      complete: true,
    };
  }

  const asked = await extract(userId, messages, spec, slot.key, slot.brief, profile, approvalOnly);
  return {
    reply: casualize(asked.reply || fallbackQuestion(slot.key)),
    options: asked.options.map((o) => o.trim().slice(0, 60)).filter(Boolean).slice(0, 4),
    spec,
    complete: false,
  };
}

/** One model call: extract slots + phrase the requested question. */
async function extract(
  userId: string,
  messages: InterviewMessage[],
  known: AgentSpec,
  slotKey: keyof AgentSpec | null,
  slotBrief: string,
  profile: Awaited<ReturnType<typeof getProfile>>,
  approvalOnly: boolean,
): Promise<{ spec: AgentSpec; reply: string; options: string[] }> {
  try {
    const res = await llmCall({
      userId,
      eventType: "converse",
      tier: automationInterview.tier,
      system: automationInterview.system,
      user: automationInterview.render({
        messages,
        known: {
          purpose: known.purpose,
          post_types: known.postTypes,
          angles: known.angles,
          hooks: known.hooks,
          source: known.source,
          platform: known.platform,
          cadence: known.cadence,
          delivery: known.delivery,
          name: known.name,
        },
        nextSlot: slotKey ? String(slotKey) : null,
        nextSlotBrief: slotBrief,
        profile: profile ? profileSummaryForPrompt(profile) : undefined,
        contentPillars: profile?.content_pillars ?? [],
        approvalOnly,
      }),
      json: true,
      maxTokens: 700,
    });
    const parsed = turnSchema.parse(res.parsed);
    const s = parsed.slots;
    return {
      spec: {
        // Anything already known stays known: a later turn must not un-fill a slot
        // just because the model didn't repeat it.
        purpose: (s.purpose ?? "").trim() || known.purpose,
        postTypes: cleanList(s.post_types).length ? cleanList(s.post_types) : known.postTypes,
        angles: cleanList(s.angles).length ? cleanList(s.angles) : known.angles,
        hooks: cleanList(s.hooks).length ? cleanList(s.hooks) : known.hooks,
        source: SOURCE_TYPES.includes(s.source as SourceType) ? (s.source as SourceType) : known.source,
        platform: s.platform === "x" || s.platform === "linkedin" ? s.platform : known.platform,
        cadence: CADENCES.includes(s.cadence as CadenceKind) ? (s.cadence as CadenceKind) : known.cadence,
        delivery: DELIVERIES.includes(s.delivery as DeliveryMode) ? (s.delivery as DeliveryMode) : known.delivery,
        name: (s.name ?? "").trim().slice(0, 60) || known.name,
      },
      reply: parsed.reply,
      options: parsed.options,
    };
  } catch (err) {
    // The interview must never dead-end on a model failure: keep what's known and
    // fall back to a plain, hand-written question for the slot code chose.
    console.error("automation interview turn failed", err);
    return { spec: known, reply: slotKey ? fallbackQuestion(slotKey) : "", options: fallbackOptions(slotKey) };
  }
}

/** Plain questions for when the model is unavailable. Never blocks setup. */
function fallbackQuestion(key: keyof AgentSpec): string {
  switch (key) {
    case "purpose":
      return "what do you want this agent to do for you?";
    case "postTypes":
      return "what kind of posts should it write — hot takes, teardowns, personal stories, how-tos?";
    case "angles":
      return "which topics is it allowed to work? name a couple of lanes.";
    case "hooks":
      return "what kind of opening line lands for you — a blunt claim, a number, a question, a story?";
    case "platform":
      return "should this agent write for X or LinkedIn?";
    case "source":
      return "should it ride what's trending in your niche, work through your idea backlog, or just follow the brief you gave me?";
    case "cadence":
      return "how often should it run — daily, weekly, or only when you hit run?";
    case "delivery":
      return "should it check with you before anything goes out, or post on its own?";
    default:
      return "tell me a bit more?";
  }
}

function fallbackOptions(key: keyof AgentSpec | null): string[] {
  switch (key) {
    case "postTypes":
      return ["hot takes", "teardowns", "personal stories", "how-tos"];
    case "hooks":
      return ["blunt claim", "a number", "a question", "story open"];
    case "platform":
      return ["X", "LinkedIn"];
    case "source":
      return ["ride trends", "my idea backlog", "just my brief"];
    case "cadence":
      return ["daily", "weekly", "only when I run it"];
    case "delivery":
      return ["ask me first", "post on its own"];
    default:
      return [];
  }
}

/**
 * Turn a completed spec into the automation input.
 *
 * The three writing slots become the BRIEF, because that is what the draft path
 * actually reads (automations/run.ts hands `brief` to generateDraft). This is the
 * whole point of the interview: previously the brief was one sentence the user
 * typed, and the agent had no idea what shape of post or hook to write.
 */
export function specToAutomationInput(spec: AgentSpec): {
  name: string;
  sourceType: SourceType;
  deliveryMode: DeliveryMode;
  cadenceKind: CadenceKind;
  platform: "x" | "linkedin";
  brief: string;
  pillarScope: string[] | null;
} {
  const brief = [
    spec.purpose ? `What this agent is for: ${spec.purpose}` : "",
    spec.postTypes.length ? `Post shapes to write: ${spec.postTypes.join("; ")}.` : "",
    spec.angles.length ? `Angles it may take: ${spec.angles.join("; ")}.` : "",
    spec.hooks.length ? `Hook styles that land for me: ${spec.hooks.join("; ")}.` : "",
  ]
    .filter(Boolean)
    .join("\n");

  return {
    name: (spec.name || spec.purpose || "Auto agent").slice(0, 60),
    sourceType: spec.source ?? "custom",
    deliveryMode: spec.delivery ?? "approval",
    cadenceKind: spec.cadence ?? "daily",
    platform: spec.platform ?? "x",
    brief: brief.slice(0, BRIEF_MAX),
    // The angles double as the pillar scope, which the run pipeline appends to the
    // seed as a hard "stay within" constraint.
    pillarScope: spec.angles.length ? spec.angles.slice(0, 6) : null,
  };
}

/** A plain-language recap of what was built, for the confirmation message. */
export function describeSpec(spec: AgentSpec): string {
  const bits: string[] = [];
  if (spec.postTypes.length) bits.push(`writes ${spec.postTypes.slice(0, 3).join(", ")}`);
  if (spec.angles.length) bits.push(`on ${spec.angles.slice(0, 3).join(", ")}`);
  if (spec.hooks.length) bits.push(`opening with ${spec.hooks.slice(0, 2).join(" or ")}`);
  bits.push(`for ${spec.platform === "linkedin" ? "LinkedIn" : "X"}`);
  const cadence =
    spec.cadence === "daily" ? "checks daily" : spec.cadence === "weekly" ? "checks weekly" : "runs when you say";
  const delivery = spec.delivery === "auto" ? "posts on its own" : "asks you first";
  return [bits.join(" "), cadence, delivery].filter(Boolean).join(" · ");
}
