### From 1.10.0, aas-api says where a device's live readings are read

Read this if something reads shells from `aas-api`. Nothing on the site has to be changed, and exported
files do not change.

From 1.10.0, a shell `aas-api` serves has one more submodel, `AssetInterfacesDescription` (IDTA 02017), id
`<globalAssetId>/submodel/AssetInterfacesDescription`. It names the live surfaces that are on:

- **the i3X server,** on by default, with the device's and each modelled metric's `elementId`;
- **the UNS bridge's broker,** while `ingestion.unsMqttEnabled` is on and the broker is published, with each
  modelled metric's topic.

So every signed-in reader of `aas-api` can read those two addresses. The submodel names the security scheme a
client uses, never a credential. With neither surface on, a shell has no such submodel.

**A client that compares a shell from `aas-api` with an exported one** finds one more submodel reference in
`aas-api`'s. An exported JSON file, an `.aasx` and a bundle never carry this submodel, because they leave the
site. [Connecting an AAS client](../../supabase/README.md#connecting-an-aas-client) says what each interface
holds.
