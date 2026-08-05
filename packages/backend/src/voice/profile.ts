import { query, queryOne } from "../db/pool.js";
import { llmCall } from "../llm/gateway.js";
import { voiceProfile } from "../prompts/voice-profile.v1.js";

/** Below this many memories we refuse to build a profile rather than produce generic slop. */
export const VOICE_MIN_MEMORIES = 50;

export interface VoiceProfileRow {
  id: string;
  user_id: string;
  version: number;
  traits: unknown;
  built_from_memory_count: number;
  created_at: string;
}

export async function currentVoiceProfile(userId: string): Promise<VoiceProfileRow | undefined> {
  return queryOne<VoiceProfileRow & Record<string, never>>(
    `SELECT * FROM voice_profiles WHERE user_id = $1 ORDER BY version DESC LIMIT 1`,
    [userId],
  ) as Promise<VoiceProfileRow | undefined>;
}

export async function buildVoiceProfile(
  userId: string,
): Promise<{ ok: true; profile: VoiceProfileRow } | { ok: false; reason: string; memoryCount: number }> {
  const countRow = await queryOne<{ count: string }>(
    `SELECT count(*)::text AS count FROM memories WHERE user_id = $1 AND status = 'active'`,
    [userId],
  );
  const memoryCount = Number(countRow?.count ?? 0);
  if (memoryCount < VOICE_MIN_MEMORIES) {
    return {
      ok: false,
      reason: `Not enough memory yet to sound like you (${memoryCount}/${VOICE_MIN_MEMORIES}). Keep capturing - a thin profile would just produce generic output.`,
      memoryCount,
    };
  }

  // Published imports carry the public voice; raw captures carry the thinking
  // voice. Only the published branch is sincerity-filtered - a shitpost risks
  // skewing the modeled PUBLIC voice, but a private chat capture should still
  // train voice regardless of register (it was never posted; nothing to weight
  // against). NULL-tolerant, mirrors memory/classification.ts#isSincereEnough.
  const samples = await query<{ content: string; source: string }>(
    `(SELECT m.content, 'published (' || c.source || ')' AS source
      FROM memories m JOIN captures c ON c.id = m.capture_id
      WHERE m.user_id = $1 AND m.status = 'active' AND (c.metadata->>'published')::boolean IS TRUE
        AND (c.sincerity_register IS NULL OR (c.sincerity_register = 'sincere' AND c.sincerity_confidence >= 0.5))
      ORDER BY length(m.content) DESC LIMIT 40)
     UNION ALL
     (SELECT m.content, 'raw capture' AS source
      FROM memories m LEFT JOIN captures c ON c.id = m.capture_id
      WHERE m.user_id = $1 AND m.status = 'active'
        AND (c.id IS NULL OR (c.metadata->>'published') IS DISTINCT FROM 'true')
      ORDER BY m.created_at DESC LIMIT 40)`,
    [userId],
  );

  const res = await llmCall({
    userId,
    eventType: "voice",
    tier: voiceProfile.tier,
    system: voiceProfile.system,
    user: voiceProfile.render({ samples }),
    json: true,
    maxTokens: 2048,
  });

  const prev = await currentVoiceProfile(userId);
  const profile = (await queryOne(
    `INSERT INTO voice_profiles (user_id, version, traits, built_from_memory_count)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [userId, (prev?.version ?? 0) + 1, JSON.stringify(res.parsed), memoryCount],
  )) as unknown as VoiceProfileRow;
  return { ok: true, profile };
}

/**
 * Nightly voice sweep. Two cases, both automatic:
 * - FIRST build for anyone who crossed the memory floor and has no profile yet
 *   (previously nothing ever built the first one - /draft silently declined
 *   for every new user until they found the manual /voice build);
 * - rebuild when memory volume has grown ~30% past the last build.
 */
export async function handleVoiceRebuild(): Promise<void> {
  const users = await query<{ user_id: string; built: string | null; current: string }>(
    `SELECT m.user_id,
            (SELECT vp.built_from_memory_count FROM voice_profiles vp
             WHERE vp.user_id = m.user_id ORDER BY vp.version DESC LIMIT 1)::text AS built,
            count(*)::text AS current
     FROM memories m WHERE m.status = 'active'
     GROUP BY m.user_id
     HAVING count(*) >= $1`,
    [VOICE_MIN_MEMORIES],
  );
  for (const u of users) {
    const current = Number(u.current);
    const built = u.built === null ? null : Number(u.built);
    const due = built === null || current >= Math.max(VOICE_MIN_MEMORIES, built * 1.3);
    if (!due) continue;
    try {
      await buildVoiceProfile(u.user_id);
    } catch (err) {
      console.error(`voice ${built === null ? "first build" : "rebuild"} failed for ${u.user_id}`, err);
    }
  }
}
