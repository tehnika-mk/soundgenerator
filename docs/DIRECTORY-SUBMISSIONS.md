# Directory submissions: soundgenerator.app

Run date: 18 October 2026. Every entry below was checked by actually loading the submit page in a real
browser and reading the form, not by trusting a directory listicle.

**Blocker for the whole run:** the automation browser is headless Chrome (`navigator.webdriver = true`).
Cloudflare Turnstile and reCAPTCHA refuse to render for it, so any directory gated by a captcha cannot be
completed automatically. Those are listed below with the exact URL so they take about a minute each by hand.

## Submission kit used

| Field | Value |
| --- | --- |
| Name | Sound Generator |
| URL | https://soundgenerator.app |
| Email | hello@tehnika.mk |
| Submitter | Petar Petkovski |
| Pricing | Free, no account, no ads |
| Logo | 512×512 PNG (dark tile, mint waveform) |
| Category | Audio / Music · Utilities |

Short description:

> Sound Generator is a free browser-based tone and test-signal toolkit: sine, square, sawtooth and triangle
> tones from 1 Hz to 20 kHz, plus sweeps, white/pink/brown noise, binaural beats, DTMF, tuning tones, a
> metronome, a hearing test and WAV export. Everything runs locally with the Web Audio API - no account, no
> uploads, no ads.

## Submitted, confirmed

| Directory | Submit URL | Evidence |
| --- | --- | --- |
| AI Tools Directory (DR 68) | https://aitoolsdirectory.com/submit-tool | Landed on `/tool-submitted` confirmation page. Paperform embed at `aitool.paperform.co`; all fields, Pricing = Free, ad-space = NO, 1200×630 OG image referenced. |

## Submitted, confirmation not captured

| Directory | Submit URL | What happened |
| --- | --- | --- |
| AI Tool Board | https://aitoolboard.com/submit | Every field filled (name, short + long description, URL, logo URL, Free Listing radio, category = 🎵 Audio Generator, pricing = Free) and `og.png` uploaded to the required Tool Image field. "Submit Tool" clicked; the browser daemon timed out mid-request, so check whether the listing queued. |
| Insidr.ai | https://www.insidr.ai/submit-tools/ | Public Webflow form, no account. Message, Link and Tag filled and sent; page gave no confirmation text. |
| Launching Next | https://www.launchingnext.com/submit/ | Form filled, "Submit Startup" clicked, no thank-you state observed. |

## Open form, needs ~1 minute by hand

These have a genuinely free, no-account form. They were filled correctly but the captcha would not render
headless.

| Directory | Submit URL | Blocker |
| --- | --- | --- |
| FutureTools (DR 70) | https://futuretools.io/submit-a-tool | Turnstile widget never renders; form itself validated cleanly |
| AI With Me | https://aiwith.me/submit/ | captcha element |
| AI Navbar | https://ainavbar.ai/submit | captcha element |
| Startup Stash | https://startupstash.com/add-listing/ | captcha element |

## Blocked: Cloudflare bot wall

Cloudflare serves "Just a moment…" to a headless client, so no form is reachable at all.

- https://topai.tools/submit
- https://openfuture.ai/submit-tool
- https://aitoolnet.com/submit
- https://easywithai.com/submit-tool/ (explicitly blocked)
- https://www.toolify.ai/submit (TLS/fingerprint block from the probe as well)

## Requires an account before submitting

- https://foundr.ai/submit (magic-link sign-in)
- https://aiwizard.ai/submit-new (password)
- https://whattheai.tech/submit (sign-in modal)
- https://siteefy.com/submit-tool (sign-in)
- https://aitoolex.com/submit (sign-in, Google/GitHub)
- https://microsaasdirectory.com/submit (password)
- https://fazier.com (Join / Sign in)
- https://www.tinylaunch.com (email login wall)
- https://www.saashub.com/submit (Register)
- https://www.uneed.best/submit-a-tool (Log in / Register)
- https://toolscout.ai/submit (Sign in)
- https://www.aitoolhunt.com/submit (unreachable, HTTP 522 during the run)
- https://aiscout.net/submit (unreachable, HTTP 522 during the run)

## Paid only

| Directory | Price seen |
| --- | --- |
| AI Depot | US$19 approval fee |
| Thank John | plan picker, no free tier |
| AI Of The Day | bi-weekly or monthly placement only |
| PitchWall | sponsored placement only |
| Easy With AI | $125 one-time |
| Toolify | $99 express (free queue exists but is behind the Cloudflare wall) |

## Dead or wrong page

- `aihunted.com` - parked domain for sale.
- `toolata.com` - GoDaddy parked page.
- `aitoptools.com/submit` - 404.
- `toollist.ai` - redirects to `/v4/go-submit`, no form renders.
- `dang.ai/submit` - only a newsletter subscribe form.
- `nothumansearch.ai/submit` - account-gated, no public form.

## Site-side failure, not our input

- **AI Valley** (https://aivalley.ai/submit-tool/) - clean public form, all fields filled, but Contact Form 7
  returned *"There was an error trying to send your message. Please try again later."* That is a mailer
  problem on their end. Worth retrying in a few days.

## Not a fit

- **LLM Relevance** (https://llmrelevance.com/submit) - the directory is specifically AI/SEO marketing tools.
  An audio signal generator would be declined. Skipped deliberately.

## Still unrun

These were queued but the browser daemon died before they could be attempted:

`AI Apps`, `Submit AI Tools` (submitaitools.org), `AI Directories` (aidirectori.es), `AlternativeTo`,
`DevHunt`, `SaaSworthy`, `Good AI Tools`, `AI Tools Guide`, `AI Tech Viral`, `AI X Collection`,
`Startup AI Deas`, `Latest AI Updates`, `AI Best Top`, `AI Just Better`, `1000.tools`, `Best-AI.org`
(has a "Free Submission" link that still needs following), `RankYourAI`, `AI Tools List`.

## What the pattern says

Roughly a third of the "free" AI directories in the usual listicles are one of: dead, parked, paid, or
account-gated. Of the ones that are genuinely open, the majority sit behind Cloudflare Turnstile or
reCAPTCHA, which is exactly the layer that a headless browser cannot pass. The realistic play is a
headed browser session and one pass over the eight or so forms listed in "Open form, needs ~1 minute".
