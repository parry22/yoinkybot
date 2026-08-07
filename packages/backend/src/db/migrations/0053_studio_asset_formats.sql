-- Expand Studio content asset formats for channel-native generation.
ALTER TABLE content_assets
  DROP CONSTRAINT IF EXISTS content_assets_asset_type_check;

ALTER TABLE content_assets
  ADD CONSTRAINT content_assets_asset_type_check CHECK (asset_type IN (
    'x_post',
    'linkedin_post',
    'short_video_script',
    'youtube_video_script',
    'newsletter_section',
    'blog_outline',
    'sales_enablement',
    'carousel_outline',
    'community_prompt',
    'reddit_post',
    'email',
    'slides_outline',
    'landing_page_section'
  ));
