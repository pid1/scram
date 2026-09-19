# scram

> A reactor scram is the emergency full shutdown: drop every rod, stop the
> reaction, ask questions later.

Cloudflare has no hard spending limit. Its budget alerts say so explicitly —
*"The alert is informational only. It does not cap your usage or impact your
account in any way"* — and they are computed once a day from the previous day's
usage, so the email arrives a day after the money is gone.

scram is the missing enforcement. It runs as a Worker in your own account, adds
up what you have actually spent this billing cycle, and when you cross a line
you set, it switches the account off.

- **Estimates in minutes, not a day.** Reads the GraphQL Analytics API every 15
  minutes and prices it against Cloudflare's published rates.
- **Discovers everything.** Every Worker, route, custom domain, cron trigger and
  `workers.dev` subdomain in the account, on every run. Deploy a new project and
  it is covered immediately — there is no list to maintain.
- **Reversible.** A trip deletes routes and clears schedules. It never deletes a
  Worker, its code, its bindings, its R2 objects or its D1 rows. The state it
  took away is written down before anything is touched, and `POST /api/restore`
  puts it back.
- **Safe by default.** Ships disarmed. It will watch and report for as long as
  you want before you let it touch anything.
- **Cannot switch itself off.** scram excludes itself from every plan, because
  a scram that disables its own route cannot be restored through its own UI.

## What it costs to run

2,880 Worker invocations a month and a D1 row per check. Comfortably inside the
free tier of the thing it is protecting you from.

## Setup

Needs Node 22+ and a Cloudflare account.

```bash
git clone https://github.com/pid1/scram && cd scram
npm install
npx wrangler login

./scripts/setup.sh      # database, migrations, secrets
npm run deploy
```

`setup.sh` prints the generated admin token at the end. **Write it down** — it
is what opens the status page, and it is not recoverable afterwards.

<details>
<summary>Doing it by hand instead</summary>

```bash
npx wrangler d1 create scram      # put the uuid in wrangler.toml as database_id
npx wrangler d1 migrations apply scram --remote

npx wrangler secret put CF_API_TOKEN
openssl rand -base64 32 | npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put NOTIFY_WEBHOOK   # optional

npm run deploy
```

</details>

### The token

scram needs a Cloudflare API token, created at
[dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens):

| Scope | Permission | Why |
|---|---|---|
| Account · Account Analytics | Read | The usage numbers |
| Account · Workers Scripts | Edit | Clear crons, disable `workers.dev`, list scripts |
| Account · Workers R2 Storage | Read | R2 operation and storage analytics |
| Account · D1 | Read | D1 row and storage analytics |
| Zone · Workers Routes | Edit (all zones) | Delete and restore routes |
| Zone · Zone | Read (all zones) | Enumerate the zones to look in |

**This token can disable every Worker in the account.** That is the entire
point of it, and it is also the reason it lives only as a Worker secret, is
never committed, and why CI here does not deploy.

### Arming it

scram deploys disarmed, because `ARMED` is a secret and starts unset. In that
state it does everything except act: it collects usage, prices it, records a
reading, and on crossing the threshold it writes a full trip record and
notifies you — marked as a dry run — listing exactly what it *would* have
disabled. Nothing changes.

Let it run for a few days. Compare the number on the status page against
**Manage Account → Billing → Billable Usage** in the dashboard. When you
believe it, arm it:

```bash
printf 1 | npx wrangler secret put ARMED
```

Disarm again at any time with `npx wrangler secret delete ARMED`. Neither needs
a redeploy.

Check what a trip would hit at any time with **What would it disable?** on the
status page, or `GET /api/preview`.

## Configuration

All of it is in `wrangler.toml` under `[vars]`, and none of it is secret.

`ARMED` is the exception: it is a **secret**, not a var, so that cloning this
repo and deploying cannot arm a kill switch against your account by accident.
Set it with `npx wrangler secret put ARMED` and the value `1`. Absent, or any
other value, means dry run.

| Var | Default | Meaning |
|---|---|---|
| `SCRAM_AT_USD` | `20` | Estimated cycle spend that trips the switch |
| `WARN_AT_USD` | `5` | Sends a notification, changes nothing |
| `BILLING_CYCLE_DAY` | `1` | Day of month your cycle starts, per the dashboard |
| `PROTECT` | *(empty)* | Extra scripts to never touch. `scram` is always included |
| `ACTIONS` | all four | `routes`, `custom_domains`, `crons`, `subdomain` |
| `CF_ACCOUNT_ID` | *(empty)* | Only needed if the token can see several accounts |

Thresholds are measured against **usage-based** spend only. Recurring
subscription fees — the $5 Workers Paid plan fee, zone plans — are not counted,
because you cannot switch them off by disabling a route, so counting them would
only eat your headroom.

### Narrowing the blast radius

`ACTIONS` decides what a trip does. Dropping an entry leaves that surface alone:

```toml
# Stop scheduled work and public traffic, but leave custom domains in place
# so the sites still resolve and return an error rather than NXDOMAIN.
ACTIONS = "routes,crons,subdomain"
```

`PROTECT` exempts specific projects:

```toml
PROTECT = "status-page,webhook-receiver"
```

## Endpoints

Everything under `/api` needs `Authorization: Bearer <ADMIN_TOKEN>`.

| | |
|---|---|
| `GET /` | Status page |
| `GET /healthcheck` | Unauthenticated, returns `ok` |
| `GET /api/status` | Current estimate, per-meter breakdown, policy, history |
| `GET /api/preview` | Everything a trip would disable right now |
| `POST /api/check` | Run a check immediately |
| `POST /api/scram` | Trip manually, ignoring the estimate. Honours `ARMED` |
| `POST /api/restore` | Undo the open trip. Optional `{"tripId": n}` |

## What a trip actually does

For every Worker except the protected ones:

1. **Routes** — deletes each zone route pointing at it. Traffic stops reaching
   the Worker and the zone serves whatever it would without one.
2. **Custom domains** — deletes the Worker custom domain binding.
3. **Crons** — clears the schedule list, so nothing fires again.
4. **workers.dev** — disables the subdomain.

What it deliberately does not do: delete Workers, delete code, delete bindings,
delete R2 buckets or objects, delete D1 databases or rows, cancel subscriptions,
or downgrade plans. Every one of those is either irreversible or does not stop
spend any faster than the four above.

Storage keeps accruing while tripped — R2 and D1 charge for bytes at rest, and
nothing short of deleting your data stops that. scram will not delete your data.
If you are tripping on storage rather than compute, it buys you time, not a cure.

## How the estimate works

`src/pricing/catalog.ts` is a plain data table of products, meters, included
allowances and rates, checked against Cloudflare's published pricing. Adding a
product you have started using means appending one object to it — the collector,
the estimator and the kill switch need no changes.

Currently priced: Workers, D1, R2, Durable Objects, Vectorize, Queues.

Rates were verified on **2026-09-19**; the date is shown on the status page so a
stale table is visible rather than quietly wrong. Re-check before relying on it.

### Where it is imprecise

- **Storage is an accrual.** GB-months are computed the way Cloudflare
  documents — daily peak, averaged over a 30-day month — so mid-cycle the
  figure is what you have accrued so far, not what the month will end at.
- **Durable Objects duration** assumes the standard 128 MB per object.
- **Unknown R2 operations** are priced as Class A, the expensive class, so a new
  operation type over-estimates rather than under-estimates.
- **Blind spots are loud.** If a collector fails, the affected product is listed
  on the status page as a blind spot and the total is flagged as an undercount.
  If *every* collector fails, scram notifies you and refuses to read $0 as safe.

The number is an estimate. It is not your invoice, and it is not a guarantee.

## Development

```bash
npm run dev          # local dev server
npm run typecheck    # tsc --noEmit
npm test             # vitest, inside workerd
npm run deploy       # wrangler deploy
```

Tests run in workerd via `@cloudflare/vitest-pool-workers` and need no
Cloudflare account. The pricing tests check against Cloudflare's own worked
billing examples, so if the rate table drifts they fail.

## Limitations

- **It is not a guarantee.** It is a Worker on the platform it is policing. If
  Cloudflare's API, the analytics pipeline or the Worker itself is down, it does
  not fire. A failed check notifies you; a platform-wide outage might not.
- **A spike faster than 15 minutes outruns it.** The floor is how quickly the
  analytics pipeline reports, not the cron interval.
- **It cannot stop subscription fees**, only usage.
- **Restoring is your call.** It will not un-trip itself, because the condition
  that tripped it is usually still true.

The genuinely hard limit Cloudflare does enforce is the **Workers Free plan**:
no usage billing at all, with a 100,000 requests/day ceiling. If your traffic
fits inside the free tier, that is a stronger guarantee than this repo. scram is
for when you want the paid plan's headroom without the paid plan's open tab.

## Licence

BSD 3-Clause. See [LICENSE](LICENSE).
