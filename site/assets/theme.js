/* Hummingbolt - theme.js. Loaded in the head, before the stylesheet, so the first paint is already in the right theme:
   a choice made with the switch (kept in this browser's localStorage as 'hb-theme') wins, then the visitor's colour
   scheme. It also marks the page as scripted ('js'), and sends old links to the values (once a view of the home page,
   /#values) to their own page. */
(function () {
  'use strict';
  var d = document, r = d.documentElement, h = location.hash, p = location.pathname, t = null;
  if ((p === '/' || p === '/index.html') && /^#(values|values-top|values-end|v-[1-4])$/.test(h)) {
    location.replace('/values/' + (/^#v-[1-4]$/.test(h) ? h : ''));
  }
  try { t = localStorage.getItem('hb-theme'); } catch (e) {}
  if (t !== 'light' && t !== 'dark') {
    t = 'dark';
    try { if (window.matchMedia('(prefers-color-scheme: light)').matches) t = 'light'; } catch (e) {}
  }
  r.setAttribute('data-theme', t);
  r.className += (r.className ? ' ' : '') + 'js';
  // the browser's toolbar takes the page colour of the theme in use (the meta tags carry one per colour scheme)
  try {
    var m = d.querySelector('meta[name="theme-color"][media*="' + t + '"]'), all = d.querySelectorAll('meta[name="theme-color"]');
    if (m) for (var i = 0; i < all.length; i++) all[i].setAttribute('content', m.getAttribute('content'));
  } catch (e) {}
})();
