/**
 * Yoinky conversion tracker (browser snippet)
 *
 * Drop on a landing / CTA page that should report observed conversion events to
 * the Yoinky web app. The server verifies the opaque token, rate-limits by
 * workspace owner, and dedupes on (workspace_id, deduplication_key).
 *
 * Usage:
 *   <script
 *     src="https://app.example.com/conversion-tracker.js"
 *     defer
 *     data-endpoint="https://app.example.com/api/conversions/webhook"
 *     data-action-id="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
 *     data-token="opaque-tracking-token"
 *     data-event-type="click"
 *     data-dedupe-key="optional-stable-id"
 *   ></script>
 *
 * Required data attributes on the <script> tag (or any element with
 * id="yoinky-conversion-tracker"):
 *   data-action-id   — conversion_actions.id (UUID)
 *   data-token       — opaque token issued when the CTA was created
 *
 * Optional:
 *   data-endpoint    — POST URL (default: same-origin /api/conversions/webhook)
 *   data-event-type  — click | signup | download | reply | demo | lead | opportunity | revenue
 *   data-asset-id    — content_assets.id
 *   data-publication-id / data-campaign-id
 *   data-dedupe-key  — stable idempotency key (default: actionId + path + day UTC)
 *   data-value / data-currency
 *
 * Fire manually: window.YoinkyConversion.track({ eventType: 'signup', ... })
 */
(function (global) {
  "use strict";

  var SCRIPT =
    document.currentScript ||
    document.getElementById("yoinky-conversion-tracker");

  function attr(name, fallback) {
    if (!SCRIPT) return fallback || "";
    var value = SCRIPT.getAttribute(name);
    return value == null || value === "" ? fallback || "" : value;
  }

  function defaultDedupeKey(actionId) {
    var day = new Date().toISOString().slice(0, 10);
    var path = (global.location && global.location.pathname) || "/";
    return [actionId, path, day].join(":");
  }

  function endpoint() {
    var configured = attr("data-endpoint", "");
    if (configured) return configured;
    if (global.location && global.location.origin) {
      return global.location.origin + "/api/conversions/webhook";
    }
    return "/api/conversions/webhook";
  }

  /**
   * @param {Record<string, unknown>} [overrides]
   * @returns {Promise<{ ok: boolean, status: number, body?: unknown }>}
   */
  function track(overrides) {
    overrides = overrides || {};
    var actionId = String(overrides.actionId || attr("data-action-id", ""));
    var token = String(overrides.token || attr("data-token", ""));
    var eventType = String(overrides.eventType || attr("data-event-type", "click"));
    if (!actionId || !token) {
      return Promise.resolve({ ok: false, status: 0, body: { error: "missing actionId or token" } });
    }

    var body = {
      actionId: actionId,
      token: token,
      eventType: eventType,
      deduplicationKey: String(
        overrides.deduplicationKey ||
          attr("data-dedupe-key", "") ||
          defaultDedupeKey(actionId),
      ),
      occurredAt: String(overrides.occurredAt || new Date().toISOString()),
    };

    var assetId = overrides.assetId || attr("data-asset-id", "");
    var publicationId = overrides.publicationId || attr("data-publication-id", "");
    var campaignId = overrides.campaignId || attr("data-campaign-id", "");
    var valueRaw = overrides.value != null ? overrides.value : attr("data-value", "");
    var currency = overrides.currency || attr("data-currency", "");

    if (assetId) body.assetId = String(assetId);
    if (publicationId) body.publicationId = String(publicationId);
    if (campaignId) body.campaignId = String(campaignId);
    if (valueRaw !== "" && valueRaw != null) body.value = Number(valueRaw);
    if (currency) body.currency = String(currency).slice(0, 3).toUpperCase();
    if (overrides.metadata && typeof overrides.metadata === "object") {
      body.metadata = overrides.metadata;
    }

    return fetch(endpoint(), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      credentials: "omit",
      keepalive: true,
    }).then(function (res) {
      return res
        .json()
        .catch(function () {
          return null;
        })
        .then(function (parsed) {
          return { ok: res.ok, status: res.status, body: parsed };
        });
    });
  }

  global.YoinkyConversion = { track: track };

  // Auto-fire once per page load when action + token are present on the script tag.
  if (attr("data-action-id", "") && attr("data-token", "") && attr("data-auto", "1") !== "0") {
    track().catch(function () {
      /* network errors are non-fatal for page UX */
    });
  }
})(typeof window !== "undefined" ? window : globalThis);
