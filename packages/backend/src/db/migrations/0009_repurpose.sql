-- Repurposing: transform existing finished material into other shapes
-- (cross-platform, cross-format, synthesis of scattered memories into one
-- piece). source_ids is an array specifically so synthesis output traces back
-- to SEVERAL memories — lineage a later diagnosis/report can cite ("this piece
-- pulled together three things you'd said since March").

CREATE TABLE repurposed_content (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_type     text NOT NULL CHECK (source_type IN
                    ('published_post','draft','memory_cluster','pasted_content')),
  source_ids      uuid[] NOT NULL DEFAULT '{}',
  mode            text NOT NULL CHECK (mode IN ('cross_platform','cross_format','synthesis')),
  target_platform text NOT NULL CHECK (target_platform IN ('x','linkedin')),
  output_text     text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  used            boolean NOT NULL DEFAULT false,
  used_at         timestamptz
);
CREATE INDEX idx_repurposed_user ON repurposed_content (user_id, created_at DESC);
