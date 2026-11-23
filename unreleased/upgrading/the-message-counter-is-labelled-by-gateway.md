### From 1.9.0, `aber_ingestion_messages_total` is labelled by gateway

From 1.9.0, `aber_ingestion_messages_total` carries an `edge_node` label beside `msg_type`. It is one series
for each gateway and message type, where it was one for each message type. Aber's own alert rules and its
System page add the series up, so they read as before. No Grafana dashboard the chart ships reads it.
There is nothing to run.

Check any panel, alert rule or recording rule of your own that reads the counter. One that does not add
the series up now answers once for each gateway, where it answered once for each message type:

```promql
# Before: one line for each message type. Now: one for each gateway and type.
rate(aber_ingestion_messages_total{msg_type="ddata"}[5m])

# The stack's rate, as before:
sum(rate(aber_ingestion_messages_total{msg_type="ddata"}[5m]))
```

- **An alert that reads the series one by one changes meaning.** A rule such as
  `rate(aber_ingestion_messages_total[5m]) == 0` now fires for each gateway that goes quiet, and no
  longer for the daemon as a whole. Wrap it in `sum(...)` for the stack, or keep it for each gateway on
  purpose with `sum by (edge_node) (...)`.
- **A query that names the type is unchanged.** `{msg_type="ddata"}` still selects. Add `sum` or
  `sum by (msg_type)` around it.
- **A script that reads the exposition line by line** sees a label it did not before. A line is
  `aber_ingestion_messages_total{edge_node="gwy…",msg_type="ddata"} 12.0`, the labels in name order, so
  match the `msg_type` by name and add up every edge node.
- **Storage grows by one series for each gateway and message type**, which is a few hundred on a site of
  a hundred gateways.

The first gap in a gateway's sequence numbers is also counted now. The daemon makes
`aber_ingestion_sequence_gaps_total` and `aber_ingestion_sequence_messages_missed_total` for a gateway at
zero when it counts its first message, where they were made at its first gap and showed no increase for it.
The **Sparkplug Message Loss** rule can fire on a gateway's first gap after the daemon starts.
