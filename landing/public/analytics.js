// GA4 for mcpfinder.dev (property 524776900).
//
// The dataLayer/gtag stub is always defined so page scripts can queue events
// unconditionally; gtag.js itself is only fetched on the production hostname,
// so workers.dev previews and localhost never report into the prod property.
//
// Conversions (no accounts or payments on this site):
//   copy_install_snippet  — visitor copies an install command / MCP config
//   click_install_link    — visitor follows the npm package link
// Also tracked, not a conversion:
//   click_repo_link       — visitor follows a GitHub repo link (nav, footer, CTAs)
// No PII: params are fixed snippet/destination ids, never copied text, and
// page_location keeps only the path plus campaign params (see cleanLocation).
(function () {
  var GA_ID = 'G-LPLFNBLWG4';
  var PROD_HOSTS = ['mcpfinder.dev', 'www.mcpfinder.dev'];
  // Query params kept in page_location; anything else (e.g. ?email=, ?token=)
  // is dropped so it never reaches GA. The fragment is dropped too.
  var KEEP_PARAMS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id', 'gclid', 'gbraid', 'wbraid'];

  function cleanLocation() {
    var out = location.origin + location.pathname;
    var kept = [];
    try {
      var params = new URLSearchParams(location.search);
      KEEP_PARAMS.forEach(function (k) {
        if (params.has(k)) kept.push(encodeURIComponent(k) + '=' + encodeURIComponent(params.get(k)));
      });
    } catch (e) {}
    return kept.length ? out + '?' + kept.join('&') : out;
  }

  window.dataLayer = window.dataLayer || [];
  window.gtag = window.gtag || function () { window.dataLayer.push(arguments); };
  gtag('js', new Date());
  // `set` before `config` so the initial page_view and every later event
  // (including enhanced measurement) use the cleaned URL.
  gtag('set', { page_location: cleanLocation() });
  gtag('config', GA_ID);

  if (PROD_HOSTS.indexOf(location.hostname) !== -1) {
    var s = document.createElement('script');
    s.async = true;
    s.src = 'https://www.googletagmanager.com/gtag/js?id=' + GA_ID;
    document.head.appendChild(s);
  }

  function snippetId(node) {
    var el = node && node.nodeType === 1 ? node : node && node.parentElement;
    var host = el && el.closest && el.closest('[data-snippet]');
    return host ? host.getAttribute('data-snippet') : null;
  }

  // Manual selection + Ctrl/Cmd+C (or context-menu copy) inside a snippet.
  // Either end of the selection may sit in the snippet (drag up or down).
  document.addEventListener('copy', function () {
    var sel = window.getSelection && window.getSelection();
    if (!sel || sel.isCollapsed) return;
    var id = snippetId(sel.anchorNode) || snippetId(sel.focusNode);
    if (id) gtag('event', 'copy_install_snippet', { snippet: id, copy_method: 'selection' });
  });

  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a[href]');
    if (!a) return;
    var href = a.href;
    if (href.indexOf('https://www.npmjs.com/package/@mcpfinder/server') === 0) {
      gtag('event', 'click_install_link', { destination: 'npm' });
    } else if (href.indexOf('https://github.com/mcpfinder/mcpfinder') === 0) {
      gtag('event', 'click_repo_link');
    }
  });
})();
