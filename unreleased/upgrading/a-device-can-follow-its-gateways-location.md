### From 1.9.0, a device can follow its gateway's location

A device now has four locations: **Follow Gateway**, a cell, Area-Wide and Site-Wide. Follow Gateway
takes whatever place the device's gateway has, and moves when the gateway does. There is nothing to
run. The upgrade moves the devices that need it (migration `0293`).

**What moves.** Until now, **In a cell** with no cell chosen meant "inherit from the gateway", and it
reached only the gateway's cell. A device behind an Area-Wide or Site-Wide gateway showed as
Unassigned. The upgrade turns every device that was In a cell with no cell into **Follow Gateway**:

- Where its gateway is in a cell, the device stays in that cell. Nothing you can see changes.
- Where its gateway is Area-Wide or Site-Wide, the device leaves **Unassigned** for that place.
- Where its gateway has no location, or it has no gateway, the device stays Unassigned.

A device with a cell of its own, or marked Area-Wide or Site-Wide, is not touched. It keeps its place
whatever its gateway does. Each move is a row in the Audit Trail, made by `migration`.

**To see how many devices move, run this before you upgrade.** Your site's number is yours, and these
notes cannot know it. The upgrade also prints it in db-init's log, as a line that starts `0293:`.

```bash
kubectl -n aber exec -i statefulset/supabase-db -c supabase-db -- psql -U supabase_admin -d postgres -c \
  "SELECT count(*) AS devices_to_move,
          count(*) FILTER (WHERE g.cell_id IS NOT NULL) AS in_its_gateways_cell,
          count(*) FILTER (WHERE g.location_scope = 'area_wide') AS area_wide_with_its_gateway,
          count(*) FILTER (WHERE g.location_scope = 'site_wide') AS site_wide_with_its_gateway
     FROM public.devices d LEFT JOIN public.gateways g ON g.id = d.gateway_id
    WHERE d.location_scope = 'cell' AND d.cell_id IS NULL;"
```

**If an API client or a script writes a device's location,** change it before you upgrade. Each of
these is now refused with HTTP 400:

- A request that writes `cell_id` alone, for a new device or one that follows its gateway, fails
  `devices_follow_gateway_has_no_place`. A device that follows its gateway has no cell. Send
  `location_scope` as `cell` with the `cell_id`.
- `location_scope` of `cell` with no `cell_id` fails `devices_cell_scope_names_a_cell`. To follow the
  gateway, send `gateway`, with no cell and no area.
- `/rest/v1/rpc/relocate_devices` and the `approve-quarantine` function refuse a move or an approval
  with `location_scope` of `cell` and no `cell_id`. On 1.8.x it meant no cell of the device's own.
  Send `gateway` instead.

The dashboard already sends all three. A device you create without a location follows its gateway.

**Where the answer shows.** `device_locations` has three new values of `location_source`:
`followed_cell`, `followed_area` and `followed_site`. A program that reads the view and switches on
the value must treat them as the place they follow. `inherited` is no longer given: a device that
took its gateway's cell now reads `followed_cell`. The Unified Namespace topic of a device that
follows its gateway is made from the gateway's place, so it changes when the gateway moves. A device
that leaves Unassigned starts to publish under a topic, if the bridge is on.
