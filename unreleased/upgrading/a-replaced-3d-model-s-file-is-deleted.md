### From 1.10.0, a replaced 3D model's file is deleted

Replacing a device's 3D model deletes the file it replaced, as removing a model does. A `File` URL in a
shell exported before the replacement then stops answering.

- **Files left by earlier replacements are deleted too, within the hour after the upgrade.** A new CronJob,
  `device-model-sweep`, runs every hour at 50 minutes past. It deletes each file in the `asset-3d-models`
  bucket that no device names, once the file is a day old. That includes any other file put in the bucket,
  and the model of a device that was deleted without being archived first.
- **A deleted device's last model is kept** if the device was archived before it was deleted.
- **To keep a file,** copy it out before upgrading: a backup with `backup.includeStorage` on holds it. Or
  set `deviceModelSweep.enabled: false` first. This lists what the first run deletes:

  ```bash
  kubectl -n aber exec -i statefulset/supabase-db -c supabase-db -- psql -U supabase_admin -d postgres -c \
    "SELECT o.name, o.updated_at FROM storage.objects o WHERE o.bucket_id = 'asset-3d-models'
       AND o.updated_at <= now() - interval '1 day'
       AND NOT EXISTS (SELECT 1 FROM public.devices d WHERE d.model_3d_path = o.name)
       AND NOT EXISTS (SELECT 1 FROM public.retired_entities r
                        WHERE r.entity_type = 'devices' AND r.old_data ->> 'model_3d_path' = o.name)
       AND NOT EXISTS (SELECT 1 FROM public.change_proposals p
                        WHERE p.entity_type = 'devices' AND p.status = 'open'
                          AND p.patch ->> 'model_3d_path' = o.name) ORDER BY 1;"
  ```

- **Under NetworkPolicies of your own** beyond the chart's, admit `device-model-sweep` to `supabase-envoy`
  on port 8000. The chart's own policies already do. Without it, each run fails and deletes nothing.
