### From 1.9.0, a device's nameplate no longer carries ConnectionMethod or Status

From 1.9.0, the Digital Nameplate of a device's AAS export has no `ConnectionMethod` and no `Status`.
There is nothing to run, and no row changes. The shell that the `aas-api` function serves is built the
same way, so it loses both too.

- **`ConnectionMethod` said nothing true about the asset.** Every device reaches Aber over Sparkplug B,
  so the value was always that, or empty. A device admitted from Quarantine had none, and its nameplate
  still carried the empty element.
- **`Status` was a live state frozen into a file.** It copied the device's `status`, ONLINE or OFFLINE,
  as it was when the file was saved. It was also not the state the Devices page shows. A device that had
  never connected read OFFLINE, and a quarantined device read ONLINE.

Neither moves into another submodel. The nameplate keeps its IDTA elements, `AssetSparkplugId`,
`EdgeGatewayName` and `EdgeGatewaySparkplugId`.

**If a program reads either element,** stop reading it. A request to `aas-api` for either one by its path
gets HTTP 404, as for any element the shell does not have. Nothing replaces `ConnectionMethod`. To read
a device's state live, ask i3X, which gives each value a quality as it is read, or read `status` on
`/rest/v1/devices`.

A file exported before the upgrade keeps the two elements it was saved with.
