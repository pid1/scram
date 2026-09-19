# scram — design notes

Working notes on why this is built the way it is. `README.md` is how to run it.

## The problem

Cloudflare sells usage-based products on an open tab. There is no hard spending
limit anywhere in the product, and this is deliberate — the platform's answer to
"how do I not get a surprise bill" is budget alerts, which have two properties
that make them useless for the actual fear:

1. They do nothing. From the changelog announcing them:
   *"The alert is informational only. It does not cap your usage or impact your
   account in any way."*
2. They are slow. *"Usage is processed once per day for the prior day's
   activity, so budget alerts fire the day after the threshold is reached rather
   than in real time."*

So the failure mode they do not cover is exactly the one worth worrying about:
a runaway loop or a traffic spike at 2am, discovered at 9am, having run
unmetered for seven hours.

The only Cloudflare-enforced hard stop is the **Workers Free plan** — 100,000
requests/day, no usage billing, requests simply fail past the cap. That is a
real guarantee and it is worth saying out loud in the README, because for a lot
of hobby accounts it is the correct answer and this repo is not needed.

scram is for the case where you want the paid plan's ceilings but not its
unbounded downside.

## Shape

A Worker in the account it polices, on a 15-minute cron.

```
cron ──> collect usage (GraphQL Analytics)
     ──> price it (static rate table)
     ──> record a reading (D1)
     ──> over threshold?
            ──> discover every disableable surface (REST)
            ──> snapshot it to D1
            ──> delete routes, clear crons, disable subdomains
            ──> notify
```

Putting it inside the account is a real tradeoff. It means scram shares a
failure domain with the thing it is protecting: a Cloudflare outage takes out
both. The alternative — running the watchdog somewhere else — removes that
correlation but adds a second platform to keep alive, pay for and hold a
Cloudflare root-ish credential. For a personal account the coupling is the
better trade, and the README says so plainly rather than pretending otherwise.

## Why 15 minutes

The cron could run every minute. It would not help. Cloudflare's analytics
datasets lag real time by a minute or two for invocations, and storage datasets
are sampled per-day. The binding constraint on how fast scram can react is
upstream of the cron, so a faster cron buys latency that does not exist and
costs invocations.

15 minutes puts the worst case at ~15 minutes of unmetered runaway versus the
~24-36 hours a budget alert gives you. That is the win; chasing the last few
minutes is not where the value is.

## Discovery over configuration

The first version of this had a list of Workers in a config var. That is wrong,
and it is wrong in the specific way that matters: the project you forget to add
to the list is the project that bankrupts you. A kill switch whose coverage
depends on remembering to update it is a kill switch with a hole in it.

So every run enumerates the account from scratch: scripts, zones, routes per
zone, custom domains, cron schedules, `workers.dev` subdomains. A project
deployed five minutes ago is covered. The config is *exclusion* only —
`PROTECT` names things to leave alone — so the default for anything new is
"covered", not "invisible".

This costs a handful of API calls per trip. Discovery only runs when the
threshold is crossed or when `/api/preview` is called, not on every tick, so
the steady-state cost is one GraphQL call and one D1 insert.

## What "off" means

Candidate mechanisms, and why the four chosen ones won:

| Mechanism | Verdict |
|---|---|
| Delete zone routes | **Yes.** Reversible, immediate, stops eyeball traffic dead |
| Delete custom domains | **Yes.** Reversible, closes the other public path |
| Clear cron triggers | **Yes.** Reversible, stops scheduled runaways |
| Disable `workers.dev` | **Yes.** Reversible, closes the default path |
| Delete the Worker | No. Irreversible. Destroys code and bindings |
| Upload a stub Worker over it | No. Destroys the deployed version |
| Delete R2 buckets / D1 databases | No. Destroys data, and data loss is worse than the bill |
| WAF block rules | No. Zone-scoped, blunt, and Workers on `workers.dev` bypass them |
| Cancel the subscription | No. Irreversible-ish, and does not stop accrued usage |

The rule that falls out: **scram only does things it can undo.** Everything it
touches is routing and scheduling metadata. Code, bindings and data are never
in scope. That is what makes it safe to arm.

The consequence, which the README states, is that storage-driven spend is not
really solvable this way. R2 and D1 bill for bytes at rest; the only way to stop
that is to delete the bytes, and scram will not delete your bytes. Against a
storage runaway it buys time to wake up, not a fix.

## The snapshot

The trip's `snapshot` column is written *before* the first delete, and holds
everything needed to reconstruct each target. This matters more than it looks:
after the routes are deleted, the account no longer knows what they were.
Discovery cannot tell you what to restore, because the thing to restore is gone.
So the undo data has to be captured at plan time and persisted, and it has to be
persisted somewhere the trip itself does not break.

A partial restore deliberately leaves the trip open, so it keeps showing on the
status page as unfinished rather than being quietly marked done.

## Self-protection

`SELF` is baked in and unioned into `PROTECT` in `readConfig`, not left to
configuration. The failure it prevents: scram deletes its own route, trips
fully, and now the status page and `/api/restore` are unreachable. You would be
restoring by hand through the dashboard, at the exact moment you least want to.

There is a test for this that asserts it holds even when `PROTECT` is set to
something else entirely.

## Failing safe vs failing open

A kill switch that silently stops working is worse than none, because it
produces false confidence. Three deliberate choices:

- **Per-product isolation.** Collectors run under `Promise.allSettled`. One
  dataset Cloudflare renames blinds one product, not the whole estimate.
- **Blind spots are loud.** Failed collectors are recorded on the reading, shown
  on the status page, and the total is labelled an undercount.
- **Total blindness never reads as $0.** If every collector fails, the estimate
  is $0 — but that is *because* scram cannot see, and treating it as "safe"
  would be exactly backwards. `check()` returns `action: "blind"` and notifies,
  and does not trip.

Conversely, tripping on a *partial* estimate is fine and intended: usage only
adds, so if the visible subset already exceeds the threshold, the real number
does too.

Notifications never throw. A webhook being down must not stop a trip.

## The rate table

`src/pricing/catalog.ts` is data, not code — products, meters, included
allowances, unit rates, and where Cloudflare documents rounding billable usage
up to a whole unit. Adding a product is appending an object.

The tests assert against Cloudflare's own published worked examples (15M
requests = $1.50; 300M Class B operations = $104.40; the 1GB-for-5-days-then-3GB
storage example = 2.66 GB-month). If someone edits a rate carelessly the suite
fails, which is the point.

`RATES_VERIFIED_ON` is surfaced in the UI. Rates change; a table that has
silently gone stale is the quiet way this whole thing becomes wrong.

## Open questions

- **Projection.** Right now scram trips on spend *so far*. It could trip on
  *projected* end-of-cycle spend, which would fire earlier on a steady climb but
  would also produce false trips early in a cycle when a single spike makes the
  run rate look catastrophic. Deliberately not done yet.
- **Rate-of-change tripping.** A separate threshold on dollars-per-hour would
  catch a runaway well before it reaches $20 in absolute terms. This is probably
  the most valuable thing to add next.
- **Staged response.** Disable crons at 50% of budget, routes at 100% — degrade
  rather than going dark in one step.
- **Restoring automatically at cycle rollover.** Tempting, and probably wrong:
  if it tripped once it will trip again, and coming back up unattended at
  midnight on the 1st is how you get a second bill.
- **Verifying the pricing table automatically.** A scheduled job that diffs
  `catalog.ts` against the published pricing pages would catch staleness. Fiddly
  and scrape-y, but the failure it prevents is silent.
