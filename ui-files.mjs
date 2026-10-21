// The files that make up the interface, in one place. build.mjs copies them, editorial/release.mjs fingerprints them,
// and tests compare them with index.html, sw.js and .vercelignore so that none of those can drift.
export const SCRIPTS=['features.js','strings-en.js','strings-de.js','strings-fr.js','i18n.js','data.js','data-reviewed.js','data-practical.js','regions.js','data-geo.js','data-towns.js',
  'planning.js','exchange.js','storage-migration.js','catalogue.js','catalogue-i18n.js','childcare.js','format.js','store.js','sync.js','exports.js','category-icons.js','views.js','childcare-views.js',
  'toast.js','map.js','app.js'];
// Loaded by app.js only when needed: the German and French card texts (scripts/compile-catalogue-i18n.mjs), only the one of the chosen language,
// and the places of the Daycare tab (scripts/compile-childcare.mjs), the first time the tab is opened.
export const LAZY_SCRIPTS=['data-de.js','data-fr.js','data-childcare.js'];
// vercel.json is not here: it belongs to the Vercel release stage (unused for Minitandem) and carries an older, weaker policy than the service and Caddy send. It stays in the repository, not in the build.
export const STATIC=['index.html','styles.css','manifest.webmanifest','sw.js','robots.txt'];
// assets/lucide.min.js and LUCIDE-LICENSE are used only by the editorial admin panel on the owner's Mac. They are not here, so they are not in the build;
// server.mjs serves the script to the panel alone, at /admin-icons.js.
// PHOSPHOR-LICENSE: the licence of the category icons, whose path data is inlined in category-icons.js.
export const ASSETS=['PHOSPHOR-LICENSE','favicon.svg','icon-512.png','apple-touch-icon.png','leaflet.js','leaflet.css','LICENSE','leaflet.markercluster.js','MarkerCluster.css','MIT-LICENCE.txt','papiliorama-outside.jpg'];
// Loaded only when the map is opened; they are part of the offline shell all the same.
export const LAZY_ASSETS=['leaflet.js','leaflet.css','leaflet.markercluster.js','MarkerCluster.css'];
// Written by build.mjs and published next to the page: the catalogue with sources, linked from the footer and from every plain page.
export const GENERATED=['research.md'];
// Written by build.mjs into the output: {revision,catalogueUpdated,records} of the catalogue as built. It holds no time of day, so a build is reproducible.
// server.mjs reads it for /healthz; .vercelignore lets it through. Not in GENERATED, because that list is copied from the source folder.
export const BUILD_INFO='build-info.json';
