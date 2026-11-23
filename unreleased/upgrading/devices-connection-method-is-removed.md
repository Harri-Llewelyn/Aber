### From 1.10.0, `devices.connection_method` is removed

1.9.0 deprecated a device's `connection_method` (see
[*`devices.connection_method` is deprecated*](../../help/site/upgrading.md#from-190-devicesconnection_method-is-deprecated)).
From 1.10.0 the column is gone (#1521). Nothing replaces it: every device reaches Aber over
Sparkplug B.

- **Stop any API client that writes or reads it before upgrading.** After the upgrade, a request
  that names it gets HTTP 400.
- **To keep its values, read them before upgrading.** The upgrade drops them with the column. This
  lists every device that holds one. No rows means none:

  ```bash
  kubectl -n aber exec -i statefulset/supabase-db -c supabase-db -- psql -U supabase_admin -d postgres -c \
    "SELECT id, name, connection_method FROM public.devices WHERE btrim(connection_method) <> '' ORDER BY name;"
  ```

- **What the upgrade does.** Migration `0317` drops the column. db-init's log says how many devices
  held a value. There is nothing to run.
- **A change proposal that names it can no longer be approved.** A new one is refused when it is
  filed. One filed before the upgrade stays open on the **Approvals** page, and approving it is
  refused. Reject it, and ask for a new proposal without the field. Nothing is approved with the
  field left out. To list the open ones, run this before or after upgrading. No rows means none:

  ```bash
  kubectl -n aber exec -i statefulset/supabase-db -c supabase-db -- psql -U supabase_admin -d postgres -c \
    "SELECT id, entity_id, proposed_by_email, proposed_at FROM public.change_proposals
       WHERE status = 'open' AND entity_type = 'devices' AND patch ? 'connection_method' ORDER BY proposed_at;"
  ```

- **The Audit Trail keeps its old rows.** A past change to a device's connection method still shows
  in them, and is still filed as **Configuration**.
