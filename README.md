# Butt Trace — Field payouts · sold as intel

> **Live app (free, no account):** https://walterhendersonjr41-blip.github.io/butt-trace/
>
> The GitHub Pages app (`index.html`, `app.js`, `style.css`, `store.js`) runs entirely in the browser with no server. Reports are signed events (Nostr kind 30078) on free public relays. Your own list and reporting key stay in your browser (localStorage). GPS must be accurate to 150 m; location is rounded to about 10 m and the area name comes from the free BigDataCloud reverse-geocoder. The map uses OpenStreetMap tiles via Leaflet. The free AI helper and data summary use the keyless Pollinations API. Open data is downloadable as CSV. Add `?ns=test` to the URL to use a separate test area.
>
> **Not in the Pages app (needs money, accounts or a legal review):** cash payouts, prize draws/sweepstakes, revenue share, data sales, phone verification and AI photo checks. Those live only in the optional self-hosted Node server described below (`server.js` + `public/`), which needs Stripe, Twilio/SMS, an xAI key and a sweepstakes/legal review before it could run for real. The Pages app says plainly that there are no cash rewards right now.
>
> The old project overview page is kept as `index.html.overview.bak` (not published).

## Optional self-hosted server version
"Point the lens. Get paid for the butt." Scanners photograph discarded cigarette butts. Grok vision checks for a butt and reads the brand, then GPS and UTC time are stamped and the scanner is rewarded. **Photos are read and then thrown away; they are never stored.** Buyers purchase aggregated litter intel on the Desk.

Single Node/Express server · SQLite (sql.js, saved to a file) · vanilla JS PWA. Pages: `#` landing, `#field`, `#desk`, `#ledger`, `#admin`, `#rules`, `#terms`, `#privacy`, `#agreement`.

## Run locally
```
npm install
ADMIN_TOKEN=demo-admin node server.js   # http://localhost:8787
```
On first start it loads **600 DEMO seed scans**. They are synthetic, use engine=`demo`, are never paid or entered in drawings, and are marked `demo=1` in CSV exports. Delete `data.sqlite` to start from zero (they are re-seeded unless you remove the seed block).

## Deploy (one command)
- **Render:** push this folder to a GitHub repo and click New → Blueprint. `render.yaml` sets up Docker, a 1 GB disk at /data, a health check, and the env vars. Then fill in the secret keys.
- **Any Docker host:** `docker build -t butt-trace . && docker run -p 8080:8080 -v bt:/data --env-file .env butt-trace`
- Camera and GPS only work over HTTPS. Render provides HTTPS automatically.

## Keys and accounts you have to supply
| What | Where | Without it |
|---|---|---|
| `XAI_API_KEY` | console.x.ai → API Keys (needs billing) | MOCK classifier. Scans are simulated, flagged, and never auto-approved |
| `STRIPE_SECRET_KEY` (start with `sk_test_`) | dashboard.stripe.com | Buy buttons and cashout say "not configured". No charges are possible |
| Stripe Connect enabled (Express) | Stripe → Connect → Get started | Scanner cash payouts are unavailable (only needed in cash mode) |
| `STRIPE_WEBHOOK_SECRET` | Stripe → Webhooks → `https://YOUR_DOMAIN/api/stripe/webhook`, event `checkout.session.completed` | Orders stay "pending" and buyers don't get API keys automatically |
| SMS provider (Twilio Verify) + `SMS_PROVIDER` | twilio.com | Codes are shown on screen (dev stub). Phone numbers aren't really verified |
| `ADMIN_TOKEN` | any long random string (Render generates one) | Admin page is locked |
| Host + domain | Render (about $7/mo plus disk) | — |
| Email provider (optional) | Resend or Postmark; replace `mail()` in server.js | Emails go only to the Admin "Outbox" |

## Reward modes (switch on the Admin page)
1. **Hybrid (default).** Each verified scan pays cash: **branded $0.10, unread $0.03** (rates can be changed on the Admin page). That's capped at **$1.00 per person per day** (also changeable). On top of that, everyone who scans gets the same single giveaway entry each day.
2. **Daily Drop only.** Scans earn no cash, only the giveaway. Each person gets **one entry a day**, from at least one verified scan or the free entry. There's no weighting and no leaderboard. 1–2 random winners a day. Scanners vote on tomorrow's prize from 3 options the admin sets. There's an optional sponsor slot. Rules are at `#rules`.
3. **Cash only.** Per-scan cash with no giveaway.

## Revenue share: 60% to scanners, 40% to operator
- **Net revenue** = paid buyer revenue minus the Stripe card fee (estimated at 2.9% + $0.30 per order).
- **Pool:** each month, **60%** of *last* month's net revenue funds the scanner pool. You can change the share on the Admin page.
- **Per-scan pay** comes out of the pool. The effective daily payout budget is the larger of your manual budget and pool ÷ 30, so the pool sets the limit, not a fixed number.
- **Monthly bonus:** whatever's left in the pool after per-scan pay is split among verified scanners in proportion to their verified scans × trust multiplier. Flagged accounts are excluded. It runs automatically on the 1st (UTC), or from the Admin button. Bonuses become withdrawable right away.
- **Operator's 40%** pays for hosting, Grok, Connect fees, and **all giveaway prizes** (prize value set by `prize_value`, default $20). The Admin page shows operator share − prizes = operator net.
- **Transparency card** on the landing page (`/api/transparency`): lifetime net revenue, this month's pool, per-scan paid, leftover for the bonus, bonuses paid, and lifetime cashed out.
- **Rate tiers** still raise per-scan rates as revenue grows (based on paid revenue over the last 30 days):

  | Buyer revenue / mo | Branded | Unread | Daily cap |
  |---|---|---|---|
  | Under $1k | $0.10 | $0.03 | $1 |
  | $1k+ | $0.15 | $0.05 | $2 |
  | $10k+ | $0.25 | $0.08 | $5 |
  | $50k+ | $0.50 | $0.15 | $15 |
- **Trust levels** multiply both the daily cap and your bonus weight. New is ×1. Trusted is ×2 (14+ days, 50+ verified scans, no rejects in 30 days). Veteran is ×3 (60+ days, 300+ verified, ≤1% rejected).
- **Example:** in month 1, buyers pay $10,000. Net is about $9,700, so month 2's pool is **$5,820**. If per-scan pay in month 2 comes to $3,000, the remaining **$2,820** becomes the bonus. Your 40% is $3,880 minus prizes (about $600–1,200 a month), which leaves about $2,700–3,300 for hosting, fees and profit.
- Month 1 has no pool because there's no prior revenue. Launch-tier per-scan pay ($0.10/$0.03, $1 cap) and the manual daily budget are fronted by the operator until revenue arrives.

## Anti-abuse controls on payouts
- Only **Grok-verified** (auto-approved) or **admin-approved** scans pay. Mock-classifier scans are never paid automatically.
- Each person can earn at most **$1.00 a day**. After that, scans still count toward the giveaway but pay $0.
- Earnings are held for **24h** before they can be withdrawn (`HOLD_HOURS`), so you can reject fraud before it's paid out. The minimum cashout is **$5**.
- **One account per phone number**, checked with an SMS code. The SMS sender is a stub: set up Twilio Verify and set `SMS_PROVIDER`. Until then the code shows on screen and in the Outbox.
- **One account per payout account.** At cashout the server reads the bank or card fingerprint from Stripe. If another user already has that fingerprint, the cashout is refused and the account is flagged.
- Scans **within 10 m** of one of your own scans earlier that day are rejected. Duplicate photos are rejected (perceptual hash). Limit of 6 scans a minute. GPS is required, and only US locations count (offline nearest-town lookup).
- The global daily payout budget (`DAILY_PAYOUT_CAP`, default $200) and the kill switch still apply.
- Sign-in uses a username and password (bcrypt).

## Revenue features
- **Sponsor slot** on the Daily Drop (admin-managed; the sponsor pays you, ideally covering the prize).
- **Free sample report** at `/sample-report`, built from demo data and labeled SAMPLE. Desk links to it.
- **Request a quote** form on Desk. Leads appear on the Admin page and as an Outbox email (set `OPERATOR_EMAIL`).
- **City Starter, $99/mo** Stripe subscription (Checkout `mode=subscription`, no Stripe dashboard product setup needed).

## Unit economics (Hybrid defaults)
- With the demo mix of 62% branded, an average scan costs about **$0.073** ($0.10×0.62 + $0.03×0.38). Grok vision adds roughly $0.002–0.01 an image.
- Your worst case per person is **$1.00 a day**, about 13 scans. The worst case overall is the global budget, **$200 a day** by default. Set it to what revenue supports. Add $20–40 a day for the giveaway, or less if a sponsor pays for the prize.
- **Revenue vs cost:** one City Starter subscription ($99/mo) pays for about 1,350 scans a month. One City sanitation heatmap ($12,400) pays for about 170,000 scans. One National brand litter share sale ($48,000) pays for about 650,000.
- **Stripe fees:** Connect Express costs $2 per active account per month plus 0.25% + $0.25 per payout. On a $5 cashout that's about $2.26, which eats into small payouts. That's why there's a $5 minimum. Consider raising it to $10–20, or paying out monthly. Checkout costs 2.9% + $0.30.
- The old cash-only rates ($0.42 and $0.14) cost about 4× as much. Use them only once you have buyer revenue.

## Anti-fraud
- Duplicate photos are rejected with a perceptual hash (dHash, Hamming distance ≤4, 7-day window).
- Limit of 6 scans per minute per user. GPS is required.
- Auto-flags: GPS jump (>150 km/h), GPS accuracy worse than 100 m, more than 300 scans a day, vision confidence below 0.75, mock engine.
- Clean scans from Grok are auto-approved. Flagged scans go to the Admin review queue. Rejected scans pay $0 and earn no entries.

## Buyer data
Buyers get an API key automatically after paying (through the webhook), or you can issue one on the Admin page. `GET /api/v1/export.csv?key=bt_...` or `Authorization: Bearer bt_...`. Coordinates are rounded to about 100 m and there are no usernames.

## Ops
`/healthz` gives the health check. The SQLite file is backed up every 6 hours to `backups/` next to the DB, keeping the last 28 copies. See OPERATOR.md.

## Legal notes (templates, not legal advice; have a lawyer review)
- **Sweepstakes:** you need the no-purchase-necessary AMOE (included), entrants must be 18+ and in the US, and it's void where prohibited. If any single prize is over $5,000, NY and FL require registration and bonding. These prizes are $20, so that doesn't apply. Keep winner records.
- **Contractors:** scanners are independent contractors. Anyone paid $600 or more in a year needs a 1099-NEC (Stripe Connect collects W-9s). The Admin page flags anyone with $500+ YTD. Prizes worth $600+ a year to one person also need a 1099-MISC.
- **No littering incentive:** the terms forbid planting or staging butts and void those earnings. The app tells people to bin butts after scanning.
- **Privacy:** images are never stored, location is tied to a username only, and buyer exports are anonymized. Images go to xAI for analysis, and the privacy page says so. Add a contact email for deletion requests.
- Pages: Terms `#terms`, Privacy `#privacy`, Scanner Agreement `#agreement`, Sweepstakes Rules `#rules`.


Created by Walter Henderson Jr.
