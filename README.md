# ledger — income tracker for działalność nierejestrowana

Tracks USD payouts from DataAnnotation, Mercor, Outlier etc., converts each to PLN at the
correct NBP rate and shows how close each quarter is to the nierejestrowana limit.
Cloudflare Workers + D1, plain JS, no build step.

## How the numbers are calculated

- **Entry date = payout date.** It decides the quarter and the exchange rate.
- **Rate:** NBP table A average (mid) USD rate from the last business day *before* the payout
  date (art. 11a ust. 1 ustawy o PIT). Fetched once from `api.nbp.pl` and cached in D1.
  Weekends and holidays are handled by taking the newest table in the 14 days before.
- **PLN** = USD × rate, rounded to the grosz. Rate, rate date and table number are stored per entry.
- **Limit:** 225% of the minimum wage in force on 1 January, per quarter:
  2026 → 10 813,50 zł, 2027 → 11 137,50 zł. Unused room doesn't carry over.
- Each September, add next year's minimum wage to `MIN_WAGE` in `src/worker.js`.

Not tax advice. The income is still taxed and reported in PIT-36; the limit only decides
whether you must register a business.

## Deploy (one time, ~5 minutes)

```bash
npm install
npx wrangler login
npx wrangler d1 create ai-income-tracker          # copy database_id into wrangler.toml
npx wrangler d1 migrations apply ai-income-tracker --remote
npx wrangler secret put INVITE_CODE            # the code you give your friend
npx wrangler deploy
```

Open the `*.workers.dev` URL, choose **Register**, enter the invite code.
Once both accounts exist you can close registration with
`npx wrangler secret delete INVITE_CODE`.

## Run locally

```bash
cp .dev.vars.example .dev.vars
npx wrangler d1 migrations apply ai-income-tracker --local
npx wrangler dev
```

## Excel export

The **Export .xlsx** button builds the file in the browser (SheetJS from cdnjs):

| Sheet | Contents |
|---|---|
| Entries | date, platform, income_usd, income_pln, nbp_rate, nbp_rate_date, nbp_table, cumulative month / quarter / total in USD and PLN, note, TOTAL row |
| Monthly | every month from first to last entry: USD, PLN, quarter-to-date, year-to-date, running total |
| Quarterly | each quarter vs the limit: remaining, % used, status |
| Info | conversion rules and the limit table used |

## Security notes

- Passwords: PBKDF2-SHA256, 20 000 iterations (kept low to fit the Workers free plan's 10 ms
  CPU limit), random 16-byte salt per user. The count is stored per user, so it can be raised later.
- Sessions: random 256-bit token in an `HttpOnly; Secure; SameSite=Strict` cookie, 30 days;
  only its SHA-256 is stored.
- Cross-origin writes are rejected; every query is scoped to the signed-in user.
- No login rate limiting — fine for two users; add a Cloudflare rate-limiting rule if you expose it wider.

## Files

```
src/worker.js              API: auth, entries, NBP rates, limits
public/index.html          UI
public/style.css           off-black / off-white theme (follows system, toggle in header)
public/app.js              dashboard logic and Excel export
migrations/0001_init.sql   D1 schema
wrangler.toml              Worker + D1 + static assets config
```
