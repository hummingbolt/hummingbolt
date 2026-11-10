# hummingbolt
Hummingbolt LLC: company home and the hummingbolt.com website.

## Website

Static HTML, CSS and JavaScript in `site/`. No build step, no cookies, no analytics, and nothing loaded from other sites.

```
site/
  index.html            home
  values/index.html     our four values
  privacy/index.html    privacy policy
  legal/index.html      legal notice
  404.html              not found (noindex)
  assets/theme.js       tiny; runs in <head> before the CSS and sets light/dark before the first paint
  assets/hb.css         all styles; the Anna's colour tokens (light and dark) as CSS custom properties
  assets/hb.js          page logic (menu, theme switch, copy button) and the feather engine (WebGL2)
  fonts/                Funnel Display and Funnel Sans (latin woff2) and OFL.txt, their licence
  favicon.svg, apple-touch-icon.png, og-image.png, robots.txt, sitemap.xml
```

- The feather scene runs on the home and values pages. It falls back to a still drawing without WebGL and holds still
  with reduced motion. The privacy, legal and not-found pages draw the same wingpath once, still, at the top.
- Colours: `TOKENS` at the top of `assets/hb.js` (the scene) and the custom properties at the top of `assets/hb.css`
  (the page) hold the same Anna's palette. Change both together.
- The only thing stored is the light/dark choice, in the browser's localStorage (`hb-theme`), once a visitor uses the
  switch. If that ever changes, update the privacy page.
- Security policy is set with a `<meta>` tag in each page (GitHub Pages has no custom headers): scripts, styles, fonts
  and images from this site only, no inline scripts or styles.
- Preview locally: `cd site && python3 -m http.server 8000`, then open http://localhost:8000/. (Python's server shows
  its own page for a missing path; GitHub Pages serves `404.html`.)
- Hosting: GitHub Pages. `.github/workflows/pages.yml` publishes `site/` when `main` changes.
