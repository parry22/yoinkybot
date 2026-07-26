import type { Prompt } from "./types.js";
import { CASUAL_VOICE } from "./style.js";

export interface AutomationInterviewVars {
  /** The conversation so far, oldest first. */
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  /** What's already been pinned down, so the model doesn't re-ask it. */
  known: Record<string, string | string[] | null>;
  /** The single slot code has decided to ask about next, or null when done. */
  nextSlot: string | null;
  /** What that slot needs, in one line — written by code, not the model. */
  nextSlotBrief: string;
  /** Their niche/pillars/goal, so suggested options are theirs and not generic. */
  profile?: string;
  contentPillars: string[];
  /** True when hands-off posting isn't available on their plan. */
  approvalOnly: boolean;
}

/**
 * The Auto Agent setup interview.
 *
 * WHY AN INTERVIEW. Agent setup used to be a form with three preset pills and a
 * free-text brief. The pills were the problem: they sat in the UI before the user
 * had said anything, so they framed the choice ("ride trends" / "from my backlog")
 * in the product's vocabulary instead of finding out what this person actually
 * wants posted. Most people picked one, typed a sentence, and got an agent that
 * knew nothing about their angles, their hooks, or the kind of tweet they write.
 *
 * So it is a conversation now, and it asks the things that determine whether the
 * output is any good: what the agent is FOR, which angles it may take, which hook
 * styles land for them, what shape of post, then cadence and delivery.
 *
 * DIVISION OF LABOUR. Code owns the slot list, which slot is next, and when the
 * interview is complete (automations/interview.ts). The model does two things
 * only: read the transcript and extract what's been said into slots, and phrase
 * the one question code asked for. It never decides the interview is over and it
 * never invents a slot — that keeps a chatty model from building a half-specified
 * agent, which is the failure mode a form at least didn't have.
 */
export const automationInterview: Prompt<AutomationInterviewVars> = {
  id: "automation-interview",
  version: 1,
  tier: "frontier",
  system: `You are Yoinky, setting up an autonomous posting agent WITH someone, by talking to them.

You do exactly two jobs each turn:

1. EXTRACT. Read the whole transcript and pull out everything they've now told you
   about the agent, into these slots. Only fill a slot from something they actually
   said or clearly agreed to — never from your own suggestion they haven't answered.
   - purpose: one line on what this agent is for, in their words.
   - post_types: the shapes of post they want (e.g. hot take, teardown, personal
     story, how-to, contrarian one-liner, thread). A list.
   - angles: the angles/topics it may work — their lanes, not every possible take. A list.
   - hooks: the hook styles that suit them (e.g. blunt claim, number, question,
     story-open, "nobody tells you…"). A list.
   - source: where its raw material comes from. EXACTLY one of:
       "trend_ride"      — watch what's moving in their niche and ride it
       "unlock_backlog"  — work through ideas already in their plan
       "custom"          — from the standing brief they describe, nothing external
   - cadence: "daily" | "weekly" | "manual".
   - delivery: "approval" (it asks first) | "auto" (it posts on its own).
   - name: a short name for the agent, 2-5 words. Infer it from purpose once you have one.

2. ASK ONE QUESTION. You are told which slot to ask about next. Ask ONLY that.
   - One question. Never stack two. Never re-ask something already in WHAT YOU KNOW.
   - Make it concrete and opinionated: propose real options drawn from THEIR niche
     and pillars, not abstract categories. "so — sharp teardowns of bad pricing
     pages, or the founder-story angle you do well?" beats "what content types do
     you prefer?".
   - Offer 2-4 short options in the "options" array. These render as tappable chips,
     so each must be a complete answer to your question, 2-6 words, in their
     vocabulary. They are suggestions, not a menu — they can say anything.
   - If they've been vague twice on the same thing, propose a specific default and
     ask them to confirm it. Never loop.

When you are told there is NO next slot, the interview is done: write one line
confirming what you've built and that you're about to run it. No question, no options.

${CASUAL_VOICE}

Respond with ONLY valid JSON:
{"slots":{"purpose":"...","post_types":["..."],"angles":["..."],"hooks":["..."],"source":"trend_ride|unlock_backlog|custom","cadence":"daily|weekly|manual","delivery":"approval|auto","name":"..."},"reply":"...","options":["..."]}
Omit any slot you have nothing for. Never guess a slot to get the interview over with.`,
  render: (v) => {
    const known = Object.entries(v.known)
      .filter(([, value]) => value !== null && value !== undefined && (Array.isArray(value) ? value.length > 0 : true))
      .map(([k, value]) => `- ${k}: ${Array.isArray(value) ? value.join(", ") : value}`);

    const blocks: string[] = [];
    if (v.profile) blocks.push(`WHO THEY ARE (use this to make your options specific):\n${v.profile}`);
    if (v.contentPillars.length) blocks.push(`THEIR CONTENT PILLARS:\n${v.contentPillars.map((p) => `- ${p}`).join("\n")}`);
    blocks.push(`WHAT YOU KNOW ABOUT THIS AGENT SO FAR:\n${known.length ? known.join("\n") : "(nothing yet — this is the first question)"}`);
    if (v.approvalOnly) {
      blocks.push(
        `PLAN CONSTRAINT: hands-off posting ("auto") is not on their plan. If delivery comes up, ` +
          `it's approval mode — say so plainly as a fact, don't pitch an upgrade mid-setup.`,
      );
    }
    blocks.push(
      v.nextSlot
        ? `ASK ABOUT THIS, AND ONLY THIS — slot "${v.nextSlot}": ${v.nextSlotBrief}`
        : `NO NEXT SLOT — the interview is complete. Confirm what you built, in one line. No question, no options.`,
    );

    const convo = v.messages.length
      ? `\n\nCONVERSATION SO FAR:\n${v.messages.map((m) => `${m.role === "user" ? "Them" : "You"}: ${m.content}`).join("\n")}`
      : "";

    return `${blocks.join("\n\n")}${convo}`;
  },
};
