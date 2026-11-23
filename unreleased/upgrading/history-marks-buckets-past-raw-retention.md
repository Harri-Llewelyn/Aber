### From 1.9.0, History marks a text or flag bucket older than the raw readings

From 1.9.0, a History chart of a text or a flag older than the raw readings marks each bucket that
held more than one value. Before, such a chart showed only each bucket's last value. Pointing at a
marked text says **more than one value in this bucket**, without a count, and a marked flag says
**both values in this bucket**.

The marks come from three new summaries on the historian: `telemetry_state_1m`, `_5m` and `_1h`.
`helm upgrade` creates them in its `timescaledb-maintenance` step, before db-init, as it creates the
other summaries. So upgrade the whole release, historian included. If only the platform database
is upgraded, History's Device, Cell and Metric tabs fail to load a window older than the raw
readings that holds a text or a flag.

**The marks start from the upgrade.** The summaries are built from the raw readings, so on the day
of the upgrade they reach back as far as the raw readings do, 14 days by default
(`timescaledb.retention.retainFor`). An older bucket gets no mark, even if it held more than one
value. Nothing goes back to fill them from the hourly summaries you already hold.

They fill in the background:

- **The last 25 hours** fill within minutes, as the other summaries' refresh does.
- **Older raw readings** fill six hours at a time, every 2 minutes, until they reach the oldest raw
  reading. That is about two hours for 14 days. The historian's log says
  `backfill_state_rollups: the state rollups reach raw telemetry's oldest hour` when it is done.

To see how far it has got, run this. `done` is true once it has reached the oldest raw reading:

```bash
kubectl -n aber exec -i statefulset/timescaledb -- psql -U postgres -d postgres -c \
  "SELECT reached, done, chunk_ms FROM public.state_rollup_backfill;"
```

**They take disk space.** On a site where most metrics are texts or flags, the 1-minute summary
holds about 70% as many rows as `telemetry_1m`. On a site of mostly numbers, it holds the share
that the texts and flags make up. They follow the retention and compression settings the other
summaries have (`timescaledb.rollups.*`), so there is no new setting. The 1-minute summary's
refresh reads the raw readings a second time, which roughly doubles that read.
