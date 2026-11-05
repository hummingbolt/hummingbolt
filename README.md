# hummingbolt
Hummingbolt LLC: company home and the hummingbolt.com website.

## Website

Plain HTML and CSS in `site/`. No build step, no scripts, no cookies.

- Preview locally: `cd site && python3 -m http.server 8000`
- Hosting: Cloudflare Workers (static assets). `wrangler.jsonc` points Cloudflare at `site/`. No build command; deploy command `npx wrangler deploy`.
- `site/_headers` sets security headers on Cloudflare.
