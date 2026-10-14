// The files that make up the interface, in one place. build.mjs copies them, editorial/release.mjs fingerprints them,
// and tests compare them with index.html, sw.js and .vercelignore so that none of those can drift.
export const SCRIPTS=['strings-en.js','strings-de.js','strings-fr.js','i18n.js','data.js','data-reviewed.js','data-practical.js','regions.js','data-geo.js','data-towns.js',
  'planning.js','exchange.js','storage-migration.js','catalogue.js','format.js','store.js','sync.js','exports.js','views.js','toast.js','map.js','app.js'];
export const STATIC=['index.html','styles.css','manifest.webmanifest','sw.js','vercel.json','robots.txt'];
// lucide.min.js and its licence are used only by the editorial admin panel, which the Mac service serves from .publish; .vercelignore keeps them off the public site.
export const ASSETS=['lucide.min.js','LUCIDE-LICENSE','favicon.svg','icon-512.png','apple-touch-icon.png','leaflet.js','leaflet.css','LICENSE','leaflet.markercluster.js','MarkerCluster.css','MIT-LICENCE.txt','papiliorama-outside.jpg'];
// Loaded only when the map is opened; they are part of the offline shell all the same.
export const LAZY_ASSETS=['leaflet.js','leaflet.css','leaflet.markercluster.js','MarkerCluster.css'];
// Written by build.mjs and published next to the page: the catalogue with sources, linked from the footer and from every plain page.
export const GENERATED=['research.md'];
