### From 1.9.0, an area or a cell cannot have a blank name

Before you upgrade, check that no area or cell has an empty name or a name of spaces. The database
now refuses one (migration `0291`).

Most sites have none. The dashboard has always refused a blank name, so only a script, an import or
an API client can have left one. Run this. No rows means you can upgrade:

```bash
kubectl -n aber exec -i statefulset/supabase-db -c supabase-db -- psql -U supabase_admin -d postgres -c \
  "SELECT 'area' AS kind, id, created_at, name FROM public.areas WHERE btrim(name) = ''
   UNION ALL
   SELECT 'cell', id, created_at, name FROM public.cells WHERE btrim(name) = ''
   ORDER BY 1, 2;"
```

Give each row a name, or delete it if it was a mistake. Open it on the **Areas** or **Cells** page and
choose **Edit Details**. Then upgrade.

If you upgrade first, db-init stops at `0291` and does not apply the migrations after it. Its log
names each row, with its table, id and the date it was made. Name them, then run `helm upgrade`
again with the same values. Nothing is renamed for you, because only you know what each one is.

An API client that writes a blank name now gets HTTP 400, naming `areas_name_not_blank` or
`cells_name_not_blank`. The dashboard already says "Give the area a name" or "Give the cell a name".
