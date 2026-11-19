// Usage analytics with PostHog (posthog.com, free tier).
//
// What we send: page views, plus a few named events from app.js (see
// track() calls): item_added, item_taken, item_emptied, undo_used,
// fridge_opened, feedback_sent. No food names, feedback text or emails.
//
// Privacy choices:
// - No cookies: PostHog's anonymous ID lives in localStorage, so the same
//   phone counts as one visitor across days.
// - Session recording is off, and autocapture is off (we only send the
//   events listed above).
// - Nothing is sent when running locally (localhost / file://).
//
// The numbers live in PostHog → Web analytics (visitors) and Product
// analytics (events). The free plan keeps about a year of data.

(function () {
  const config = window.FREEDGE_CONFIG || {};
  const local = location.protocol === 'file:' ||
    ['localhost', '127.0.0.1', ''].includes(location.hostname);
  if (!config.posthogKey || local) return;

  // PostHog's standard loader: makes a stand-in `posthog` that queues calls
  // until the real library (array.js) finishes downloading.
  !function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host.replace(".i.posthog.com","-assets.i.posthog.com")+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+".people (stub)"},o="capture identify alias people.set people.set_once set_config register register_once unregister opt_out_capturing has_opted_out_capturing opt_in_capturing reset isFeatureEnabled onFeatureFlags getFeatureFlag getFeatureFlagPayload reloadFeatureFlags group onSessionId".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);

  window.posthog.init(config.posthogKey, {
    api_host: config.posthogHost,
    persistence: 'localStorage',
    autocapture: false,
    capture_pageview: true,
    capture_pageleave: true,
    disable_session_recording: true,
    person_profiles: 'identified_only', // anonymous visitors only; cheaper
  });
})();

// Sends one named event. Safe to call even when analytics is off or
// blocked by an ad blocker: it just does nothing.
function track(event, properties) {
  try {
    window.posthog?.capture?.(event, properties);
  } catch {
    // Analytics must never break the app.
  }
}
