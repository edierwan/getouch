/* ═══════════════════════════════════════════════════════════
   Getouch — Client-side status updater
   Works on both landing page (badges) and admin (health grid)
   ═══════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  /* ── Landing page: update [data-service] badges ─────── */
  function updateBadge(name, status) {
    var badges = document.querySelectorAll('[data-service="' + name + '"]');
    badges.forEach(function (el) {
      if (status === 'ok') {
        el.className = 'badge badge--ok';
        el.innerHTML = '<span class="badge__dot"></span>Online';
      } else {
        el.className = 'badge badge--offline';
        el.innerHTML = '<span class="badge__dot"></span>Offline';
      }
    });
  }

  /* ── Admin page: update #health-{name} items ────────── */
  function updateHealthItem(name, svc) {
    var dot = document.querySelector('#health-' + name + ' .health-item__dot');
    var url = document.querySelector('#health-' + name + ' .health-item__url');
    var lat = document.getElementById('lat-' + name);

    if (dot) {
      dot.className = 'health-item__dot health-item__dot--' + (svc.status === 'ok' ? 'ok' : 'offline');
    }
    if (url) {
      var detail = svc.status;
      if (svc.version) detail = 'v' + svc.version;
      if (svc.model)   detail += ' · ' + svc.model;
      url.textContent = detail;
    }
    if (lat && svc.latency_ms !== undefined) {
      lat.textContent = svc.latency_ms + 'ms';
    }
  }

  /* ── Fetch /api/status (server-side probes) ─────────── */
  fetch('/api/status')
    .then(function (r) { return r.json(); })
    .then(function (data) {
      var entries = Object.entries(data.services);
      entries.forEach(function (pair) {
        var name = pair[0];
        var svc  = pair[1];
        updateBadge(name, svc.status);
        updateHealthItem(name, svc);
      });
    })
    .catch(function () {
      // Set all dynamic badges to unknown
      document.querySelectorAll('[data-service]').forEach(function (el) {
        el.className = 'badge badge--offline';
        el.innerHTML = '<span class="badge__dot"></span>Unknown';
      });
    });

  /* ── Self health → landing #health-landing ──────────── */
  fetch('/health')
    .then(function (r) { return r.json(); })
    .then(function (d) {
      var dot = document.querySelector('#health-landing .health-item__dot');
      var url = document.querySelector('#health-landing .health-item__url');
      var lat = document.getElementById('lat-landing');
      if (dot) dot.className = 'health-item__dot health-item__dot--ok';
      if (url) url.textContent = 'v' + d.version;
      if (lat) lat.textContent = '0ms';
    })
    .catch(function () {
      var dot = document.querySelector('#health-landing .health-item__dot');
      if (dot) dot.className = 'health-item__dot health-item__dot--offline';
    });
})();
