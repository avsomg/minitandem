// Starts the interface after the stylesheet. index.html loads only this file (defer), and a deferred script runs only once styles.css has
// arrived, so the stylesheet has the connection to itself and the heading and intro are painted before the scripts download: on a slow phone
// connection 27 scripts beside the stylesheet held the first paint back by about a second (Lighthouse LCP 2.4 s, 18 November 2026).
// The scripts then load in this order and run in it (async=false), as the deferred tags did. The list is ui-files.mjs SCRIPTS (site.test.mjs).
(() => {
  const files = ['features.js', 'strings-en.js', 'strings-de.js', 'strings-fr.js', 'i18n.js', 'data.js', 'data-reviewed.js', 'data-practical.js', 'regions.js', 'data-geo.js', 'data-towns.js',
    'planning.js', 'exchange.js', 'storage-migration.js', 'catalogue.js', 'catalogue-i18n.js', 'childcare.js', 'format.js', 'store.js', 'sync.js', 'exports.js', 'category-icons.js', 'views.js', 'childcare-views.js',
    'toast.js', 'map.js', 'app.js'];
  for (const file of files) {
    const script = document.createElement('script');
    script.src = file;
    script.async = false;
    document.head.appendChild(script);
  }
})();
