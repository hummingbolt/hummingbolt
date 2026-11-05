# hummingbolt
Hummingbolt LLC: company home and the hummingbolt.com website.

## Website

Plain HTML and CSS in `site/`. No build step, no scripts, no cookies.

- Preview locally: `cd site && python3 -m http.server 8000`
- Hosting: Cloudflare Pages, build output directory `site`, no build command.
- `site/_headers` sets security headers on Cloudflare Pages.
