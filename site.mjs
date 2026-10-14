// The one place that names the public origin of the site. Everything that needs it imports it from here:
// per-card pages, sitemap, the Mac service's allowed origins. index.html, robots.txt and the web manifest are static files;
// a test compares them with this constant.
export const SITE_ORIGIN='https://minitandem.ch';
