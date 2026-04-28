# Perf Phase 3 — L-4 APM scoping

**Date:** 2026-04-28
**Owner:** Hector
**Status:** Scoping only — no code in this PR. Captures the decision criteria, vendor comparison, and rollout sketch for adopting a real APM (Application Performance Monitoring) tool when Sentry's free-tier traces aren't enough signal.
**Source plan:** [`performance-prep-2026-04-28.md`](./performance-prep-2026-04-28.md)

This doc closes out the planning track for **Phase 3 / L-4**. We're not implementing it yet — Phase 1 (`I-1` traces, `I-2` slow-query log, `I-3` slow-request breadcrumb) just shipped, and we should let it run for a couple of weeks before deciding whether the free-tier signal is enough.

## What "real APM" actually buys

Sentry today (after Phase 1 deploy) gives us:

- Per-request traces at 10% sample rate.
- Prisma slow-query warnings (>200 ms) in the Winston log stream.
- Slow-request breadcrumbs (>1 s) on Sentry events.
- Error tracking with stack traces.

A real APM gives us all of the above plus:

- **100% trace sampling** without sample-rate trade-offs (or smart sampling that keeps the slow ones).
- **Distributed traces** that span backend → DB → external API calls in a single timeline. Today we'd have to correlate Prisma logs against Sentry traces by request ID manually.
- **Real-time dashboards** — CPU, memory, event-loop lag, GC, request rate, error rate — without us building them.
- **Custom metrics** — `cache.stats()` size, Redis pub/sub messages/sec, counter-table refresh rate — exposed to charts and alerts without writing exporters.
- **Synthetic checks + alerting** — uptime monitors that page on degradation, not just outages.
- **Profiling** — flame graphs of CPU + heap so you can see *which line* is slow, not just *which endpoint*.

## When we'd actually need this

Sentry traces (Phase 1) are sufficient when:

- Total traffic is low enough that 10% sample captures the long tail.
- Errors and slow requests are easy to correlate by request ID in logs.
- "Why is this slow?" is answerable from the slow-query log + the request breadcrumb.

The signs you've outgrown that:

| Signal | Threshold |
|---|---|
| Sentry quota | Approaching free-tier event limit (~5K/mo) consistently |
| Trace gaps | Investigating an incident, the user's specific request fell outside the 10% sample, you can't reconstruct what happened |
| Log volume | Slow-query log producing > 500 lines/hour, hard to spot patterns by eye |
| Cross-system traces | Reservation create touches DB + payment gateway + email + SMS — any of those lag and Sentry's single-hop trace doesn't show where time went |
| User-reported regressions | Customer says "it was slow at 2pm yesterday" and we can't easily pull a trace from that time window |
| Memory leaks | `process.memoryUsage()` heap trending up across the day; we have no historical chart to confirm |

Hit two of those for two consecutive weeks → APM time.

## Vendor comparison

Four realistic options, ranked by what fits this app's shape:

### Option A — Sentry Performance Plus (simplest path)

**What:** upgrade the existing Sentry account from the free Developer plan to Team or Business tier. Same SDK, same API, same instrumentation we already have. You get higher sample rates, profiling, dashboards, and longer retention.

**Cost:** Team is $26/mo for 50K events. Business starts at $80/mo for 100K events + better retention.

**Effort:** zero engineering work — same `Sentry.init()` call. Set `SENTRY_TRACES_SAMPLE_RATE=1.0` once you upgrade.

**Pros:** continuity. The slow-request breadcrumb pattern from Phase 1 already drops events in the right place. No new SDK to learn.

**Cons:** Sentry's perf product is good but not great. Distributed-trace UX is shallower than Datadog. No first-class log-correlation (you'd still grep Winston output).

**When this is the right answer:** if you want a small upgrade that delivers ~70% of the value and ships in 5 minutes.

### Option B — Datadog APM (heaviest hitter)

**What:** Datadog Agent runs on the droplet, captures traces + logs + metrics + RUM. Industry-standard distributed tracing.

**Cost:** $31/host/mo for APM. Add ~$15/host/mo for infrastructure metrics. ~$50-65/host total. Multi-host plans get volume discounts.

**Effort:** ~1 day. Install Agent (`apt install` + systemd), add `dd-trace` to backend (`require('dd-trace').init()` at top of `main.js`), set `DD_*` env vars, restart. Logs auto-correlate with traces via the request ID.

**Pros:** best-in-class distributed traces. Service map auto-generates from observed traffic. Native log + trace correlation. Anomaly detection without you defining rules.

**Cons:** expensive at scale. Vendor lock-in concerns. Datadog's billing model has historically surprised people with per-host + per-log-line + per-metric charges that compound.

**When this is the right answer:** if you ever expand to 5+ services or need vendor support during incidents.

### Option C — Honeycomb (high-cardinality observability)

**What:** modern observability tool. Very strong on "ask arbitrary questions about my system" via BubbleUp + heatmaps.

**Cost:** Pro plan starts $130/mo for 100M events/mo. Free tier exists (20M events/mo) but is limited.

**Effort:** ~0.5 day. OpenTelemetry SDK in backend, send to Honeycomb endpoint via the OTel Collector or directly.

**Pros:** built around the assumption that you'll ask questions of the data you didn't pre-anticipate. "What's the p99 of /api/reservations/page for tenant X on Tuesday afternoons?" is a 30-second query, not a multi-step setup.

**Cons:** smaller community than Datadog. Pricing is event-volume-based which can spike under load tests. Less of a turn-key dashboard product — you build your own queries.

**When this is the right answer:** if the engineering team values exploratory observability over pre-built dashboards.

### Option D — Self-hosted OpenTelemetry + Grafana stack

**What:** OpenTelemetry SDK in backend → OTel Collector → Tempo (traces) + Loki (logs) + Prometheus (metrics) → Grafana dashboards. Or use Grafana Cloud's hosted tier.

**Cost:** Grafana Cloud free tier is generous (10K metrics, 50GB logs, 14-day retention). Pro is $8/mo per active user. Self-hosting is ~$50/mo for the storage tier on DO.

**Effort:** ~2-3 days. OTel SDK in backend, deploy the Grafana Agent or self-host the LGTM stack. More upfront wiring than the SaaS options.

**Pros:** vendor-neutral (OTel is the standard). Grafana Cloud free tier covers a lot. Self-host option exists if cost or compliance forces it.

**Cons:** more pieces to learn. Dashboards aren't pre-built.

**When this is the right answer:** if cost is the dominant concern, or if compliance requires on-prem observability data.

## Recommendation

**Plan A first, B if A isn't enough.** Specifically:

1. **First $26-80/mo:** upgrade Sentry to Team or Business tier. Bump sample rate to 1.0. Watch for 30 days.
2. **If Sentry's perf product hits a ceiling** (you're constantly switching between Sentry traces and Winston logs to investigate), evaluate Datadog vs Honeycomb on a 30-day trial. Pick based on which one your eng team finds easier to query at 2am during an incident.
3. **Self-hosted is the fallback** if either of those becomes expensive at scale, or if compliance forces it.

The reason for the staged approach: **the cheapest tool is the one you already have**, and Sentry post-Phase-1 is already pretty good. Don't pay for Datadog until you've felt the pain of Sentry's limits.

## What changes in the codebase when we adopt L-4

### Sentry Performance Plus (Option A)

- Bump `SENTRY_TRACES_SAMPLE_RATE` to `1.0` (or smart sampling rate) in droplet env.
- Optionally enable Sentry profiling: `Sentry.init({ profilesSampleRate: 1.0 })` in `lib/sentry.js`.
- No code change beyond two env vars.

### Datadog APM (Option B)

- Add `dd-trace` to `package.json` dependencies.
- First line of `backend/src/main.js` becomes `import './dd-trace-init.js';` which calls `tracer.init()` before any other module loads.
- Install Datadog Agent on the droplet via `apt`.
- Set `DD_API_KEY`, `DD_SERVICE=fleet-management-backend`, `DD_ENV=production`, `DD_VERSION=<git-sha>` in droplet env.
- Optionally swap `winston` formatter to inject `dd.trace_id` and `dd.span_id` so logs auto-correlate with traces.

### Honeycomb (Option C)

- Add `@opentelemetry/api` + `@opentelemetry/sdk-node` + `@honeycombio/opentelemetry-node`.
- Top of `main.js`: `import { HoneycombSDK } from '@honeycombio/opentelemetry-node'; new HoneycombSDK({ ... }).start();`.
- Set `HONEYCOMB_API_KEY` + `OTEL_SERVICE_NAME` env vars.

### OpenTelemetry / Grafana (Option D)

- Add `@opentelemetry/auto-instrumentations-node`.
- `main.js` top: `import { NodeSDK } from '@opentelemetry/sdk-node';` + start.
- Deploy Grafana Agent or run the OTel Collector as a sidecar. Point at Grafana Cloud or self-hosted Tempo/Loki.

## What stays unchanged regardless of which we pick

- The Phase 1 instrumentation (`requestLogger`, Prisma slow-query log, slow-request Sentry breadcrumb) keeps working. APM tools layer on top, they don't replace.
- Caching (Phase 1 + Phase 3 L-1) is independent.
- The L-5 load test gives the same data either way.

## Decision framework when L-4 time arrives

Walk through these questions in order. The first "yes" tells you which option:

1. **Are we already paying Sentry and is the team happy with the SDK?** → Option A.
2. **Are we headed toward a multi-service architecture (booking, payments, ops as separate services)?** → Option B (Datadog's distributed tracing earns its keep).
3. **Does the team explicitly want exploratory query-based observability?** → Option C (Honeycomb).
4. **Is monthly cost the primary constraint, or do we have on-prem requirements?** → Option D (self-host).
5. **Default if none of the above:** Option A.

## What this PR explicitly does NOT do

- Adopt any tool.
- Change `SENTRY_TRACES_SAMPLE_RATE`.
- Add any APM SDK.
- Pay for any plan upgrade.

It's a planning artifact. The signal to start implementation is **two of the decision criteria above** firing for two consecutive weeks against a Phase-1-deployed backend.

## Cross-references

- Phase 1 instrumentation closeout: [`perf-phase1-2026-04-28.md`](./perf-phase1-2026-04-28.md)
- Phase 2 query reduction closeout: [`perf-phase2-2026-04-28.md`](./perf-phase2-2026-04-28.md)
- Phase 3 L-1 Redis closeout: [`perf-phase3-redis-cache-2026-04-28.md`](./perf-phase3-redis-cache-2026-04-28.md)
- Phase 3 L-2 counter table closeout: [`perf-phase3-summary-counters-2026-04-28.md`](./perf-phase3-summary-counters-2026-04-28.md)
- Phase 3 L-3 read-replica scoping: [`perf-phase3-read-replica-scoping-2026-04-28.md`](./perf-phase3-read-replica-scoping-2026-04-28.md)
- Phase 3 L-5 load test closeout: [`perf-phase3-load-test-2026-04-28.md`](./perf-phase3-load-test-2026-04-28.md)
