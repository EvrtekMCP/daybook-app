// DAYBOOK — the safety net under the app (0.3.0). A plain script (not a module),
// loaded before the app: if the app has not started within a minute (a broken update,
// say), it reloads the page quietly, and keeps trying every minute while the local
// server answers. After a broken update is rolled back, that reload brings back the
// version before. main.js sets window.daybookBooted once the first screen is drawn.
(function () {
  'use strict';
  var m = /[?&]watchMs=(\d{3,6})(?:&|$)/.exec(location.search);     // the tests use a shorter wait
  var WAIT = m ? Number(m[1]) : 60000;
  function check() {
    if (window.daybookBooted) return;
    fetch('health', { cache: 'no-store' }).then(function (r) { return r.text(); }).then(function (t) {
      if (t !== 'daybook' || window.daybookBooted) return setTimeout(check, WAIT);
      try { sessionStorage.setItem('daybook.quiet', String(Date.now())); } catch (e) { /* fine */ }
      location.reload();
    }).catch(function () { setTimeout(check, WAIT); });
  }
  setTimeout(check, WAIT);
})();
