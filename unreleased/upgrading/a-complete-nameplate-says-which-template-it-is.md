### From 1.10.0, a complete Digital Nameplate names its template

Read this if something reads Aber's AAS exports or `aas-api`. Nothing on the site has to be changed.

From 1.10.0, a device's `DigitalNameplate` submodel carries
`https://admin-shell.io/idta/nameplate/3/0/Nameplate` (IDTA 02006) as its `semanticId`, once every element the
template asks for has a value. Until then it carries none, as before. To let it conform, the submodel changed
in four ways, all in this release. There is no window in which both forms are written.

#### What moved, and what is gone

| Was in `DigitalNameplate` | From 1.10.0 |
| :--- | :--- |
| `AssetSparkplugId` | In a new submodel, idShort `PlatformConnection`, id `<globalAssetId>/submodel/PlatformConnection`. The same id is in the shell's `specificAssetIds`, as `sparkplugId` |
| `EdgeGatewayName` | In `PlatformConnection` |
| `EdgeGatewaySparkplugId` | In `PlatformConnection` |
| `ManufacturerProductDesignation` holding the device's own name, where nothing was recorded | Gone. The device's name is the site's. The element is there only where somebody recorded a designation, or the device publishes one |

The properties keep their idShorts, and neither they nor the new submodel carry a `semanticId`.

#### What changed type

The template types these four, and they were all `xs:string` Properties:

| Element | From 1.10.0 |
| :--- | :--- |
| `ManufacturerName`, `ManufacturerProductDesignation` | A MultiLanguageProperty. `value` is a list with one entry, `[{ "language": "en", "text": "..." }]`. `/$value` answers `[{ "en": "..." }]` |
| `URIOfTheProduct` | A Property of `xs:anyURI` |
| `DateOfManufacture` | A Property of `xs:date` |

#### What is new

- `OrderCodeOfManufacturer`, and `AddressInformation` with `Street`, `Zipcode`, `CityTown`, `StateCounty` and
  `NationalCode`. Each is there when it has a value.
- **A device with no nameplate value has no `DigitalNameplate` submodel.** `aas-api` answers its id with a `404`,
  and the shell does not list it. It always had one before, because the platform's properties and the device's
  name were in it.

#### What to do

1. In a client that reads the three platform properties, read them from `PlatformConnection`.
2. In a client that reads `ManufacturerName` or `ManufacturerProductDesignation`, read `value[0].text`.
3. To have a nameplate name its template, open the device's **Digital Nameplate**. The dialog lists the fields
   that are still empty: the product URI, manufacturer, product designation, order code, and the manufacturer's
   street, postal code, town or city, and country code.

A shell exported before the upgrade still has the old form. Export it again for a server that keeps a copy.

#### The dialog

The dialog marked **Year of Construction** as mandatory and the order code not at all, which is version 2.0's
answer. Version 3.0 swapped the two. From 1.10.0 the year is not marked and **Order Code** is, and
`idta_submodel_templates.is_mandatory` says the same.
