# Shopfloor Operations — intentionally empty

`dashboards.yml` declares a provider pointing here, and it has nothing to provision on a fresh
install. That is the intended state, not a missing file.

**The dashboard that used to live here is
[`simulation/grafana/dashboards/manufacturing-cells.json`](../../../../simulation/grafana/dashboards/manufacturing-cells.json).**
Roadmap §14 moved it there with the rest of the demonstrator, because its panels hardcode
`Sim_CNC_Mill_01` — so on an install running real plant it named a machine that does not exist,
in a folder an operator would reasonably read as describing their floor.

## Enabling it

```bash
cp simulation/grafana/dashboards/*.json grafana/provisioning/dashboards/shopfloor/
docker compose restart grafana
```

On Kubernetes it is a values flag rather than a copy, because the chart bakes its files in:

```bash
helm upgrade acs-cymru deploy/helm/acs-cymru --reuse-values \
  --set simulation.grafana.enabled=true
```

The same flag also loads
[`simulation/grafana/alerting/shopfloor-alert-rules.yaml`](../../../../simulation/grafana/alerting/shopfloor-alert-rules.yaml)
— the three machine rules that were split out of `grafana/provisioning/alerting/alert-rules.yaml`
at the same time. On Compose those are a second copy into `grafana/provisioning/alerting/`; the
init step globs `*alert-rules.yaml`, so dropping the file in is all that is needed.

**The dashboard has nothing to show until the floor exists.** Run `npm run provision:gateways`
first, or follow [`simulation/README.md`](../../../../simulation/README.md) to build one machine by
hand and point a copy of the dashboard at it.

## Why this file, rather than an empty directory

Git does not track empty directories, and `docker-compose.yml` bind-mounts
`./grafana/provisioning/dashboards` wholesale. Without something here the path would not exist
after a clone, the mount would create it as a root-owned directory, and Grafana's provider would
log an error on every sweep about a directory it cannot read — which looks like a Grafana fault
rather than a deliberately empty folder. Grafana's file provider only reads `*.json`, so this
file is invisible to it.
