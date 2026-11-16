### From 1.9.0, a replay lane shows its machine's 3D model

A replay lane no longer holds a 3D model of its own. It shows the model of the device it was recorded
from. You do not need to do anything. The upgrade moves the models that lanes already hold (migration
`0294`).

For each replay lane that holds a model:

- **If its device has no model,** the device takes the lane's model and the lane is cleared. The model
  now shows on the device, and the lane shows it from there.
- **If its device has a model,** the lane's is cleared and the device keeps its own.
- **If a device has two lanes that both hold one,** the device takes the older lane's and the other is
  cleared.

No file is moved, copied or deleted. The file stays in the `asset-3d-models` bucket, where the lane's
upload put it, and the device's model opens and downloads from there as before. A link to it that
someone copied still works. **Remove** on the device deletes the file.

To see which lanes hold a model before you upgrade, run this. No rows means nothing moves:

```bash
kubectl -n aber exec -i statefulset/supabase-db -c supabase-db -- psql -U supabase_admin -d postgres -c \
  "SELECT l.name AS lane, l.model_3d_path AS lane_model, m.name AS device, m.model_3d_path AS device_model
     FROM public.devices l JOIN public.devices m ON m.id = l.shadow_of
    WHERE l.model_3d_path IS NOT NULL ORDER BY 1;"
```

db-init names each lane it moves or clears in its log, and each change is a row in the Audit Trail,
written by the migration.

After the upgrade, a lane's drawer offers **View 3D Model** when its device has one, and nothing about a
model when it has none. The view is read-only, and says whose model it is. To change a model, open the
device it was recorded from.

Two things refuse a model on a lane from now on. An API client that sets `model_3d_path` on a lane gets
HTTP 400, naming `devices_a_replay_lane_has_no_model`. A client that uploads a file to
`asset-3d-models/<lane id>/...` is refused by the storage policy. Upload to the device instead.

A lane's AAS export carries no 3D model, because the lane has none. Export the device.
