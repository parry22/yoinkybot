-- The stated brand profile: what the user tells us about themselves in the
-- Stage 1-7 onboarding conversation, BEFORE we read their public history. The
-- gap analysis (Stage 10) measures their actual posts against this. One row per
-- user; fields are filled in turn-by-turn during the paced intake. Additive.

CREATE TABLE brand_profiles (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  version                   integer NOT NULL DEFAULT 1,

  -- Stage 1: Positioning
  niche                     text,
  sub_niche_angle           text,
  credibility_source        text,
  unique_pov                text,

  -- Stage 2: Goal (primary is single-valued; secondaries are extra)
  primary_goal              text CHECK (primary_goal IS NULL OR primary_goal IN
                              ('job','leads','authority','product','funding','audience','community')),
  secondary_goals           text[] NOT NULL DEFAULT '{}',

  -- Stage 3: Audience
  audience_who              text,
  audience_sophistication   text CHECK (audience_sophistication IS NULL OR
                              audience_sophistication IN ('beginner','intermediate','expert','mixed')),
  audience_pain_point       text,

  -- Stage 4: Voice and tone (tone_selections holds stable taxonomy KEYS)
  inspiration_creators      text[] NOT NULL DEFAULT '{}',
  tone_selections           text[] NOT NULL DEFAULT '{}',
  formality_gradient        text CHECK (formality_gradient IS NULL OR
                              formality_gradient IN ('very_casual','casual','balanced','professional','corporate')),
  vulnerability_threshold   text CHECK (vulnerability_threshold IS NULL OR
                              vulnerability_threshold IN ('none','selective','open','very_open')),

  -- Stage 5: Content pillars (derived from Stages 1-3, then confirmed)
  content_pillars           text[] NOT NULL DEFAULT '{}',
  content_pillars_confirmed boolean NOT NULL DEFAULT false,

  -- Stage 6: Format and platform behavior
  camera_comfort            text CHECK (camera_comfort IS NULL OR camera_comfort IN ('no','maybe','yes')),
  visual_comfort            text CHECK (visual_comfort IS NULL OR visual_comfort IN ('text_only','simple','rich')),
  primary_platform          text CHECK (primary_platform IS NULL OR primary_platform IN ('x','linkedin','both')),
  platform_adaptation       text CHECK (platform_adaptation IS NULL OR platform_adaptation IN ('adapt','exclusive')),
  posting_capacity          integer,                          -- honest posts/week

  -- Stage 7: Constraints and guardrails
  employer_restrictions     text,
  topics_off_limits         text[] NOT NULL DEFAULT '{}',
  anonymity_needs           text CHECK (anonymity_needs IS NULL OR
                              anonymity_needs IN ('real_name','pseudonymous','anonymous')),

  -- Bookkeeping. `unresolved` names fields the user was pushed on once and still
  -- couldn't answer (the spec's "note as unresolved rather than force it").
  unresolved                text[] NOT NULL DEFAULT '{}',
  profile_completed_at      timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id)
);
CREATE INDEX idx_brand_profiles_user ON brand_profiles (user_id);

-- Two new onboarding stages sit BEFORE 'connected' now: 'profiling' (mid Stage
-- 1-7 intake) and 'profile_set' (intake done, ready to connect). Old values are
-- kept so users already mid-flow at deploy stay valid and the connect-first
-- escape hatch still works.
ALTER TABLE users DROP CONSTRAINT users_strategist_stage_check;
ALTER TABLE users ADD CONSTRAINT users_strategist_stage_check CHECK (strategist_stage IN
  ('new','profiling','profile_set','connected','diagnosed','goals_set','plan_active'));
