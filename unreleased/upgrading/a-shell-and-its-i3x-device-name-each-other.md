### From 1.10.0, a shell and its i3X device name each other

Read this if something reads Aber's AAS shells or its i3X server. Nothing on the site has to be changed.

From 1.10.0, the two views of a device say that they describe one device, and i3X carries its nameplate.

#### In a shell

Each telemetry submodel's `Segments` collection holds a second history link, `I3XLinkedSegment`, after
`LinkedSegment`. It is there while the chart publishes the i3X server, which it does by default:

- `Endpoint` is the i3X server's `/v1/objects/history`.
- `Query` is a JSON body naming the submodel's metrics by their i3X elementIds,
  `{"elementIds": ["<sparkplug_id>/<metric name>", ...]}`. A client adds a `startTime` and an `endTime`.

`LinkedSegment` is as it was, so a client that reads only it is not affected. Exported files, `.aasx`
packages and `aas-api` all carry the new link.

#### On the i3X server

- **Each device names its shell.** `metadata.system` holds `aasShellId` and `aasGlobalAssetId` beside
  `quarantined`. They are under the base IRI the chart gives the AAS export
  (`supabaseFunctions.aas.baseIri`), which the i3X server is now given too.
- **A device's nameplate is a component.** A device whose nameplate has a value has a `Nameplate`
  object, `i3x:nameplate:<sparkplug_id>`, in its `HasComponent` list. Its value is the nameplate's
  fields, and it has no history.
- **A device's components are not all metrics.** A client that took every `HasComponent` child of a
  device for a metric should skip the one typed `i3x:type:nameplate`. A device with no metrics but a
  nameplate is now `isComposition: true`.
- **One more namespace while a device has a nameplate:**
  `https://admin-shell.io/idta/nameplate/3/0?projection=i3X`, for the `Nameplate` type.
