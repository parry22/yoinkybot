/**
 * Shared strategist data shapes — the pure, cross-file types of the onboarding /
 * diagnosis / plan arc, collected in one place (the same pattern `trends/
 * provider.ts` uses for the trend domain). Types only: no runtime values and no
 * imports from sibling modules, so any strategist file can depend on this
 * without an import cycle.
 *
 * NOTE on what deliberately does NOT live here: types derived from runtime const
 * arrays — `ProfileField` (from PROFILE_FIELDS), `DiagnosisBeat`/`PlanBeat`
 * (from DIAGNOSIS_BEATS/PLAN_BEATS) — stay beside their arrays in profile.ts /
 * state.ts. Moving them would either strand runtime values in a types file or
 * split a `const` from the type derived off it. Only pure interfaces migrate.
 */

/** The persisted brand profile row (brand_profiles) — the user's stated inputs. */
export interface BrandProfile {
  id: string;
  user_id: string;
  version: number;
  niche: string | null;
  sub_niche_angle: string | null;
  credibility_source: string | null;
  unique_pov: string | null;
  primary_goal: string | null;
  secondary_goals: string[];
  audience_who: string | null;
  audience_sophistication: string | null;
  audience_pain_point: string | null;
  inspiration_creators: string[];
  tone_selections: string[];
  formality_gradient: string | null;
  vulnerability_threshold: string | null;
  content_pillars: string[];
  content_pillars_confirmed: boolean;
  camera_comfort: string | null;
  visual_comfort: string | null;
  primary_platform: string | null;
  platform_adaptation: string | null;
  posting_capacity: number | null;
  employer_restrictions: string | null;
  topics_off_limits: string[];
  anonymity_needs: string | null;
  unresolved: string[];
  profile_completed_at: string | null;
  created_at: string;
  updated_at: string;
}
