# Election night: Georgia & Florida

A one-page, phone-friendly dashboard for following tonight's Georgia and Florida results:
governor, U.S. Senate and U.S. House up top, with a county map and county table for every race.

All numbers come straight from the states' own election-night feeds and refresh every minute:

- **Georgia**: Secretary of State results site (`results.sos.ga.gov`), public JSON API.
  Tonight's election is found automatically by date. County detail is fetched per race when you open it.
- **Florida**: Division of Elections election-night file
  (`flelectionfiles.floridados.gov/enightfilespublic/20261103_ElecResultsFL.txt`), one row per candidate per county.

These are unofficial returns. The page shows who is ahead; it never calls a race.

## How it works

One Cloudflare Worker (free plan is plenty):

- serves the static page from `public/`
- proxies the two state feeds at `/api/...` (browsers can't call them directly), caching each for 30 seconds
  so a houseful of phones only hits the state sites about twice a minute
- keeps the last good copy for 24 hours and serves it if a state site stumbles

The browser does the parsing (`public/js/parse.js`), so the Worker stays tiny.

## Deploy (about 5 minutes)

**From the Cloudflare dashboard (no terminal needed):**

1. Workers & Pages → Create → **Import a repository** → pick this GitHub repo.
2. Leave the build command empty and the deploy command as `npx wrangler deploy`. Save and deploy.
3. Open the `*.workers.dev` link it gives you.
4. Optional: Worker → Settings → Domains & Routes → **Add custom domain** (e.g. `election.yourdomain.com`).

Every push to the repo redeploys automatically.

**Or from a terminal:** `npm install && npx wrangler login && npx wrangler deploy`

## Check it before polls close

| URL | What it shows |
| --- | --- |
| `/api/health` | Whether Cloudflare can reach both state feeds right now |
| `/?demo=1` | Made-up numbers that grow every refresh, to see the map and layout |
| `/?fldate=20241105` | Florida's real 2024 general file, to confirm Florida parsing end to end |
| `/?gaslug=2024NovGen` | Georgia's real 2024 general, to confirm Georgia parsing and county maps |

Tonight, plain `/` is all anyone needs. Polls close at 7 p.m. Eastern in Georgia and in most of Florida
(8 p.m. Eastern in the panhandle's Central-time counties); expect the first numbers shortly after.

## If something goes wrong tonight

- **A yellow/red note says a state's feed couldn't be reached**: the page keeps showing the last numbers it got
  and retries every minute. Check `/api/health`.
- **Georgia says tonight's results page isn't posted**: the state hasn't published the election yet. If it's
  listed under another date or name, add `?gaslug=<publicElectionId>` (the id is in the URL of the race page
  on results.sos.ga.gov).
- **Florida returns a web page instead of data** (a bot check): nothing on our side can fix that; use
  [floridaelectionwatch.gov](https://floridaelectionwatch.gov/) directly.

## Files

- `src/worker.js`: the Worker (static files + cached proxy)
- `public/index.html`, `public/style.css`, `public/js/app.js`: the page
- `public/js/parse.js`: turns each state's feed into one shape
- `public/js/demo.js`: fake numbers for `?demo=1`
- `public/geo/*.json`: county outlines, pre-drawn from the U.S. Census-based `us-atlas`
  (rebuild with `scripts/build-geo.mjs`)
