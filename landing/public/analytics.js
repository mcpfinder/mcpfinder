// GA4 for mcpfinder.dev (property 524776900).
//
// The dataLayer/gtag stub is always defined so page scripts can queue events
// unconditionally; gtag.js itself is only fetched on the production hostname,
// so workers.dev previews and localhost never report into the prod property.
//
// Conversions (no accounts or payments on this site):
//   copy_install_snippet  — visitor copies an install command / MCP config
//   click_install_link    — visitor follows the npm package or GitHub repo link
// No PII: params are fixed snippet/destination ids, never copied text.
(function () {
  var GA_ID = 'G-LPLFNBLWG4';
  var PROD_HOSTS = ['mcpfinder.dev', 'www.mcpfinder.dev'];

  window.dataLayer = window.dataLayer || [];
  window.gtag = window.gtag || function () { window.dataLayer.push(arguments); };
  gtag('js', new Date());
  gtag('config', GA_ID);

  if (PROD_HOSTS.indexOf(location.hostname) !== -1) {
    var s = document.createElement('script');
    s.async = true;
    s.src = 'https://www.googletagmanager.com/gtag/js?id=' + GA_ID;
    document.head.appendChild(s);
  }

  function snippetId(el) {
    var host = el && el.closest && el.closest('[data-snippet]');
    return host ? host.getAttribute('data-snippet') : null;
  }

  // Manual selection + Ctrl/Cmd+C (or context-menu copy) inside a snippet.
  document.addEventListener('copy', function () {
    var sel = window.getSelection && window.getSelection();
    if (!sel || sel.isCollapsed) return;
    var node = sel.anchorNode && sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode && sel.anchorNode.parentElement;
    var id = snippetId(node);
    if (id) gtag('event', 'copy_install_snippet', { snippet: id, copy_method: 'selection' });
  });

  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a[href]');
    if (!a) return;
    var href = a.href;
    var destination =
      href.indexOf('https://www.npmjs.com/package/@mcpfinder/server') === 0 ? 'npm' :
      href.indexOf('https://github.com/mcpfinder/mcpfinder') === 0 ? 'github' : null;
    if (destination) gtag('event', 'click_install_link', { destination: destination });
  });
})();
