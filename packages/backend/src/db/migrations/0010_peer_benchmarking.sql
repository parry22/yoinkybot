-- Peer benchmarking: a small, user-defined set of named peers, tracked only
-- through their own public posting, compared only against the user's own
-- throughline and baseline. DELIBERATELY no memories/positions/voice rows for
-- peers — that machinery exists to understand the user who opted in, and
-- applying it to a third party would be an unjustified use of it. Theme-level
-- comparison only, enforced here by giving peers a lighter table, not a graph.

CREATE TABLE peer_profiles (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  peer_handle       text NOT NULL,
  platform          text NOT NULL CHECK (platform IN ('x','linkedin')),
  relationship_note text,                 -- why the user picked this peer
  active            boolean NOT NULL DEFAULT true,
  added_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, platform, peer_handle)
);

CREATE TABLE peer_captures (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  peer_profile_id    uuid NOT NULL REFERENCES peer_profiles(id) ON DELETE CASCADE,
  external_id        text,                -- provider post id/url for dedup
  content            text NOT NULL,
  published_at       timestamptz NOT NULL,
  engagement_metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  classified_theme   text,                -- broad theme label, cheap-tier, batch-classified
  ingested_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (peer_profile_id, external_id)
);
CREATE INDEX idx_peer_captures ON peer_captures (peer_profile_id, published_at DESC);

CREATE TABLE peer_comparison_snapshots (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  peer_profile_id uuid NOT NULL REFERENCES peer_profiles(id) ON DELETE CASCADE,
  period_start    timestamptz NOT NULL,
  period_end      timestamptz NOT NULL,
  peer_baseline   real,
  user_baseline   real,
  theme_overlap   jsonb NOT NULL DEFAULT '{}'::jsonb,  -- {shared, peerOnly, userOnly, overlapPct}
  computed_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_peer_snapshots ON peer_comparison_snapshots (user_id, computed_at DESC);
