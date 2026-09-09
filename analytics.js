/* Visitor counts and rough behaviour, and nothing beyond that.
 *
 * PostHog, loaded only when TOKEN below is filled in. That is the project's
 * public API key — it is meant to ship in the page, it only writes, and it
 * reads nothing back, so it belongs in the repo like any other config.
 *
 * The settings are deliberately modest. Session recording is off: this is a
 * public calendar, watching people use it is not what "how many visitors"
 * asks for, and it is the single heaviest thing PostHog can do to a page.
 * Do Not Track is honoured. No identify() call is made, so nobody is given a
 * name — the numbers are counts of browsers, which is what the question was. */

(function () {
  var TOKEN = 'phc_BSSD59VrmXw7jK2ZzQtxYWYu8Efz5VLFE5gdefd5WYgi';   /* Explora */
  var HOST  = 'https://us.i.posthog.com';

  if (!TOKEN) return;
  if (navigator.doNotTrack === '1' || window.doNotTrack === '1') return;

  /* PostHog's own loader, trimmed to the parts this uses. */
  !function (t, e) {
    var o, n, p, r;
    e.__SV || (window.posthog = e, e._i = [], e.init = function (i, s, a) {
      function g(t, e) {
        var o = e.split('.');
        2 == o.length && (t = t[o[0]], e = o[1]);
        t[e] = function () { t.push([e].concat(Array.prototype.slice.call(arguments, 0))); };
      }
      (p = t.createElement('script')).type = 'text/javascript';
      p.crossOrigin = 'anonymous';
      p.async = !0;
      p.src = s.api_host.replace('.i.posthog.com', '-assets.i.posthog.com') + '/static/array.js';
      (r = t.getElementsByTagName('script')[0]).parentNode.insertBefore(p, r);
      var u = e;
      for (void 0 !== a ? u = e[a] = [] : a = 'posthog', u.people = u.people || [],
           u.toString = function (t) {
             var e = 'posthog';
             return 'posthog' !== a && (e += '.' + a), t || (e += ' (stub)'), e;
           }, u.people.toString = function () { return u.toString(1) + '.people (stub)'; },
           o = 'init capture register register_once register_for_session unregister unregister_for_session getFeatureFlag getFeatureFlagPayload isFeatureEnabled reloadFeatureFlags updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures on onFeatureFlags onSessionId getSurveys getActiveMatchingSurveys renderSurvey canRenderSurvey getNextSurveyStep identify setPersonProperties group resetGroups setPersonPropertiesForFlags resetPersonPropertiesForFlags setGroupPropertiesForFlags resetGroupPropertiesForFlags reset get_distinct_id getGroups get_session_id get_session_replay_url alias set_config startSessionRecording stopSessionRecording sessionRecordingStarted captureException loadToolbar get_property getSessionProperty createPersonProfile opt_in_capturing opt_out_capturing has_opted_in_capturing has_opted_out_capturing clear_opt_in_out_capturing debug'.split(' '),
           n = 0; n < o.length; n++) g(u, o[n]);
      e._i.push([i, s, a]);
    }, e.__SV = 1);
  }(document, window.posthog || []);

  posthog.init(TOKEN, {
    api_host: HOST,
    person_profiles: 'always',
    capture_pageview: true,
    capture_pageleave: true,       /* so "time on page" means something */
    autocapture: true,             /* which cards and filters get tapped */
    disable_session_recording: true,
    respect_dnt: true,
  });

  /* Two things the calendar can say that a pageview cannot: which time window
     someone actually reads, and what they open. Both are card-level, neither
     carries anything about the person. */
  document.addEventListener('click', function (e) {
    var card = e.target.closest && e.target.closest('.card');
    if (card && card.dataset.event) {
      posthog.capture('listing opened', {
        listing: card.dataset.event,
        category: (card.className.match(/card--([a-z]+)/) || [])[1] || null,
        price_bucket: card.dataset.price || null,
      });
      return;
    }
    var tab = e.target.closest && e.target.closest('.tab');
    if (tab) posthog.capture('window tab', { window: tab.textContent.trim() });
  }, true);
}());
