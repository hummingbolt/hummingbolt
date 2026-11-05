# hummingbolt
Hummingbolt LLC: company home and the hummingbolt.com website.

## Website

Plain HTML and CSS in `site/`. No build step, no scripts, no cookies.

- Preview locally: `cd site && python3 -m http.server 8000`
- Hosting: GitHub Pages. `.github/workflows/pages.yml` publishes `site/` when `main` changes.
- Security policy is set with a `<meta>` tag in each page (GitHub Pages has no custom headers).
