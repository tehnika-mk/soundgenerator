# Deploying soundgenerator.app

The site is a pure static build (`dist/`) with no server runtime, no environment
variables and no API routes. Any static host works; the three below are the usual
choices and all have free tiers with automatic HTTPS.

## Build settings (all hosts)

| Setting | Value |
| --- | --- |
| Install command | `npm install` |
| Build command | `npm run build` |
| Publish directory | `dist` |
| Node version | 20 or newer |
| Environment variables | none |

`astro.config.mjs` already sets `site: 'https://soundgenerator.app'`, which drives
canonical URLs, Open Graph tags and `sitemap-index.xml`. Change that one line if the
domain ever changes.

## Netlify

`netlify.toml` is included, so connecting the repository is enough:

```bash
npm install -g netlify-cli
netlify deploy --build --prod
```

## Vercel

`vercel.json` is included (`framework: astro`):

```bash
npm install -g vercel
vercel --prod
```

## Cloudflare Pages

Create a Pages project from the repository and set the build command to
`npm run build` with output directory `dist`.

## DNS for soundgenerator.app

Apex (`soundgenerator.app`) - use the host's recommended records:

| Type | Name | Value | Notes |
| --- | --- | --- | --- |
| A | `@` | `75.2.60.5` | Netlify load balancer (host-specific - copy from the dashboard) |
| CNAME | `www` | `<project>.netlify.app` | or `cname.vercel-dns.com`, or `<project>.pages.dev` |

If deploying to Vercel, the apex is normally an `A` record to `76.76.21.21`; Cloudflare
Pages uses a `CNAME` to `<project>.pages.dev` (flattened automatically at the apex).
Always copy the exact values the host's dashboard shows for the project - they change.

Redirect `www` to the apex (or the reverse) in the host's domain settings and enable
"force HTTPS" so both names serve one canonical URL.

## After the first deploy

```bash
npm run verify        # static checks against dist/
npm run qa -- --base=https://soundgenerator.app   # full sweep against production
```

Then, outside the repo:

1. Submit `https://soundgenerator.app/sitemap-index.xml` in Google Search Console and
   Bing Webmaster Tools.
2. Check the Lighthouse scores on a real device - the pages are static and script-light,
   so the remaining work is usually image/OG metadata rather than code.
3. Regenerate the social preview whenever the brand or the feature list changes:
   `npm run build && npm run preview` in one terminal, `npm run og` in another. The script
   loads `/og-card`, screenshots it at 1200x630 and verifies the PNG, so the preview card
   always matches the site.

## Caching

Both `netlify.toml` and `vercel.json` set long-lived caching for `/_astro/*` (hashed
build assets) and no-cache for HTML, so a deploy is visible immediately while fonts,
scripts and CSS stay cached.
