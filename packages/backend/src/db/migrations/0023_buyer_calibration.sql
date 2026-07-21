-- Buyer Radar per-user threshold recalibration (§3j feedback loop). Verdicts on
-- surfaced signals are the training signal: 'not_a_fit' is the highest-signal
-- correction (the domain match was wrong) and tightens the niche gate; 'skipped'
-- nudges the intent bar up; 'replied' loosens toward surfacing more. Thresholds
-- are re-derived deterministically from the recent verdict mix and stored here
-- as a per-user override of the global config defaults. Additive only.
CREATE TABLE buyer_calibration (
  user_id         uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  intent_threshold real NOT NULL,   -- overrides config.INTENT_THRESHOLD for this user
  niche_threshold  real NOT NULL,   -- overrides config.BUYER_NICHE_THRESHOLD for this user
  updated_at      timestamptz NOT NULL DEFAULT now()
);
