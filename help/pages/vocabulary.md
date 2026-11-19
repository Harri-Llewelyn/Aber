## What this page is for

This page holds reference vocabularies: the published sets of terms that industrial standards define. Use them to label a metric in this deployment with the same term somebody else's system already uses. The standards are for reading, and nothing in them is edited. The **Imported** tab holds vocabularies your own site brought in. [The Imported tab](#the-imported-tab) says how.

## What the controls do

- **The six standard tabs**, MTConnect, ISO 22400, OPC UA, ASHRAE 223P, QUDT and VDA 5050, each show one standard's entries in the same card. Switching tab keeps the search text, so the same search can be tried on each standard in turn.
- **Point at a tab**, or move to it with the keyboard, to read what that standard covers. What each standard is, and what to watch for in it, is under **The six standards** below.
- **Search** filters the selected standard by name and by the text shown on hover. For example, an ISO 22400 KPI is found by its formula. A search opens the sections that match.
- **The sections** group each standard's entries. MTConnect has data item types, components, sub types and units. ISO 22400 has KPI families, OPC UA has companion specifications, ASHRAE 223P has superclasses, QUDT has one for each first letter, and VDA 5050 has the parts of the vehicle state. Sections start collapsed.
- A section header shows **N in use** when catalog metrics already use N of its entries. Where a section needs explaining, a **?** sits beside its title. A header stays at the top of the card while its entries scroll under it.
- **Expand all** is at the start of the line above the sections, at the far left. It opens every section of the selected standard, and reads **Collapse all** while any is open. Collapse all also closes the sections a search opened, and keeps the search.
- **Click an entry** to start a catalog metric from it. An entry you can click shows a **+** when you point at it or tab to it. It opens the Add Metric dialog on the Metrics page, with the type, the semantic identifier and the reference type already filled in.
- This saves typing the identifiers by hand. They are long and exact, and a typing mistake in one goes unnoticed.
- Only some entries can be clicked. In MTConnect, these are data item types, not components, sub types or units. Every ISO 22400 KPI, every OPC UA data point and every VDA 5050 field can be clicked. In ASHRAE 223P, classes can be clicked, but relations cannot. Every QUDT quantity kind can be clicked.
- Entries already in use are ticked, and you can still click them. Clicking needs the Administrator role; without it the entries are read-only.
- **ASHRAE 223P is a reference here.** Clicking a 223P class opens Add Metric in the BMS group, with the class as the type. It fills in no semantic identifier, datatype or units. Choose those yourself. A class names a piece of equipment, such as a temperature sensor, not the reading it takes. A 223P class is ticked when a 223P metric is named after it.
- **A QUDT quantity kind** opens Add Metric as a Custom metric, with the kind as its semantic identifier. Give the name, the datatype and the unit yourself. A kind is ticked when a catalog metric carries it as its own id or as a further id.
- **A unit** in the MTConnect vocabulary is listed by its code, such as CELSIUS. The Metrics page shows it with its symbol, **°C (CELSIUS)**, and History shows the symbol alone.

## The six standards

### MTConnect

The words an MTConnect metric name is built from. They are generated from the `mtconnect/schema` repository.

- **It is a list of words, not of metrics.** It is what the standard makes available, not what your devices publish.
- **Names are composed.** A metric is a component path plus a data item type. So `ANGLE` here becomes `Axes/C/ANGLE` in the catalog.
- **Its semantic ids are local.** MTConnect publishes no ids, so this deployment makes one for each entry. Point at an entry to see it.
- **A data item type shows its definition.** Point at one to read what MTConnect says it is. An AAS export gives the same text as the concept's definition. A type MTConnect does not describe, such as `ELEVATION`, shows its name alone.

### ISO 22400

The manufacturing KPIs that ISO 22400-2 defines. These are computed measures. MTConnect leaves them out on purpose, because it reports raw machine state and stops there.

- **A KPI is picked whole.** It is not composed like an MTConnect name. `AVAILABILITY` becomes `OEE/AVAILABILITY` in the catalog, with the KPI's unit and semantic id. Point at a KPI to see its formula, in the standard's symbols.
- **Beware the name clash.** MTConnect's own `AVAILABILITY` is a different thing. It is an event meaning the device is connected, not this ratio.
- **Four KPIs cite a source.** `AVAILABILITY`, `EFFECTIVENESS`, `QUALITY` and `OEE` were read from OPC 40501-1 v1.02.0, Annex C.2.4. That annex is free to read, and says it takes its KPI definitions from ISO 22400-2. Point at one of them to see the source on its last line. The same line is the `sourceOfDefinition` of the KPI's concept in an AAS export.
- **Four KPIs are deprecated.** `UTILIZATION`, `SCRAP_RATIO`, `MTBF` and `MTTR` are marked **deprecated** on the tab, and the line under a KPI's tooltip says why. `UTILIZATION` is not an ISO 22400 KPI. No free source publishes the formulas of the other three.
- **They stay for now.** A metric that already carries one of their ids keeps it. The four are removed no sooner than 1.10.0.
- **A site that owns ISO 22400-2 can import it on the Vocabulary page.** That brings in its KPIs with your licence recorded, so Aber does not ship copies nobody has checked.

### OPC UA

Data points from the OPC UA companion specifications: `OPC 40001` (Machinery), `OPC 40001-2` (Machinery Process Values), `OPC 40010` (Robotics), `OPC 40501` (Machine Tools), `OPC 40540` (Additive Manufacturing), `OPC 30050` (PackML) and `OPC 40001-4` (Machinery Energy).

- **Names are positional**, as in MTConnect. `ActualPosition` becomes `MotionDevice/J1/ActualPosition` once you say which axis. Choosing a point fills in its group too.
- **Each point carries its NodeId**: a namespace and an id, written `nsu=…;i=…`. That is the ExpandedNodeId the specification's NodeSet publishes for the point. It is also the point's semantic id, and an OPC UA client finds the same node by it.
- **A printer is a machine tool.** The OPC 40540 section lists feedstock and the printing technology. The Machine Tools and Machinery sections apply to a printer too. Its in-process readings are process values. OPC 40001-2 gives their shape, and the vendor names each one.
- **Some points are enumerations.** A device publishes one as the member's name, so it is a String. The point's description lists the values, as it does for `Function`. Type them in **Permitted Values** when you add the metric.

### ASHRAE 223P

The semantic concepts that ASHRAE 223P defines for building systems: HVAC, electrical, and the sensing around them. The sections follow the standard's own class hierarchy.

- **It is a reference, not a source of ids.** `Fan` names a piece of equipment, not a reading. You choose the datatype, units and id yourself, such as a quantity kind from the QUDT tab.
- **It is still in public review.** These concepts come from the open223 pre-publication ontology. They may change before ASHRAE 223 is published.

### QUDT

The quantity kinds that QUDT defines. A quantity kind says what a reading measures, such as `Temperature` or `VolumeFlowRate`. Each section holds the kinds that start with one letter.

- **Quantity kinds from QUDT 3.5.2, by QUDT.org, under CC BY 4.0.** The credit is on the tab, and the licence is linked from it. Kinds QUDT has deprecated are left out.
- **A kind is not a standard.** It names what a reading measures, not the reading itself. So it is never the id of an MTConnect, ISO 22400, OPC UA or VDA 5050 metric. Those keep their own standard's id.
- **Where it is the id.** A Custom metric and an ASHRAE 223P metric can have a kind as their own semantic id. Any metric can have one as a further id, which says what the metric measures without replacing its own.
- **QUDT's own ids.** QUDT publishes each kind's id, so it is not made here. Point at a kind to see it.
- **A kind shows QUDT's description.** Some kinds have none in English, and then the tab shows the name alone.

### VDA 5050

The readings an automated guided vehicle (AGV) reports in the `state` message of VDA 5050. They are generated from the JSON Schema the VDA publishes, at version 3.0.0. VDA 5050 3.0 calls the vehicle a mobile robot.

- **A field is a reading.** `powerSupply.stateOfCharge` is the battery's charge. `driving` says whether the vehicle is moving. Point at a field to read the VDA's description of it.
- **A field is picked whole.** Click one to start a metric in the AGV group. The field's path becomes the name, so `velocity.vx` becomes `AGV/velocity/vx`. The datatype, the semantic identifier and the values of an enum, such as the seven operating modes, are filled in.
- **The unit is not filled in.** The VDA writes `m/s`, and a metric's unit is an MTConnect unit name. Choose it yourself.
- **Its semantic ids are local.** The VDA publishes no ids, so this deployment makes one for each field. Point at a field to see it.
- **Only readings are here.** The message header, the order fields and the lists, such as `loads` and `errors`, are left out. A list cannot be a metric, and a device's identity comes from its Sparkplug topic.
- **A position is a reading on the device.** It is never the cell the device is in.
- **This lists the readings and nothing more.** A vehicle must still publish them as Sparkplug B metrics. Connecting a fleet that speaks VDA 5050 is separate work.

## The Imported tab

The Imported tab holds vocabularies your site brought in itself. It can be your group's naming standard, a customer's specification, or the terms of a standard you hold a copy of. Every role can read them. Only an Administrator can import, remove or share one, and the buttons are greyed for anyone else.

## Import a vocabulary

1. Open the **Imported** tab and press **Import vocabulary**.
2. Choose a file. It can be an `.aasx` package, or an AAS JSON or XML file. Aber reads it in your browser. Nothing is written yet.
3. Read what the file holds. The preview shows the format, the version the file states, and how many concepts will be imported.
4. Say what the file is. Choose **A published standard**, or **The site's own vocabulary**. For a standard, give its name, edition and publisher, such as `ISO 22400-2`, `2014` and `ISO`.
5. Check the name, add a licence note if you want one, and press **Import vocabulary**.

- **Only concepts with IEC 61360 content are taken.** The other ConceptDescriptions in the file are counted and skipped.
- **The preview lists what is already defined.** A term that one of the standards on this page defines, or another imported file, is skipped. The preview says which one.
- **A file is imported once.** The same file again is refused, and the message names the vocabulary that holds it.
- **The licence is your site's responsibility.** Aber keeps the text in this database, and every role can read it here. Do not import a file whose licence forbids that.
- **A file that could do harm is refused, with the reason.** That means a file over 25 MB, or a package with more than 5,000 entries, an entry over 50 MB, more than 100 MB in all, or an entry that expands to more than 100 times its size. It also means an entry named with an absolute path, `..`, a backslash or a drive letter, and an XML file with a document type.
- **The definitions start unshared.** See [Share the definitions](#share-the-definitions).

## Use an imported concept

Click a concept to start a catalog metric from it, as you do on any other tab. The metric is a local extension that is linked to its vocabulary. Its name is made from the preferred name, and you can change it before you add it.

- **The Metrics page names the vocabulary.** A published standard shows as **ISO 22400-2:2014 (site licence)**, so nobody takes it for a standard Aber ships. The site's own vocabulary shows its name.
- **The Standard filter lists each published standard you imported.** A site's own vocabulary is a local extension, so it is under **Local extension**.
- **The description is filled in only when the definitions are shared.** Until then, write your own.
- **A metric from an ISO 22400 file is a KPI.** The AAS export files it under KeyPerformanceIndicators.

## Share the definitions

Press **Share definitions** and confirm that your licence allows it. Until you do, an AAS export carries each concept's id and preferred name, and says its definition is the vocabulary's. It also leaves out the description of each metric that carries one of those ids, in case it is a copy. Once you do, it carries the definition text and the metrics' descriptions. **Stop sharing** takes it back.

## Remove a vocabulary

Press **Remove**. The dialog says how many metrics use the vocabulary. Those metrics keep their ids and lose the link. An export of them uses the catalog's description again. You can import the file again later.

## Why this is a separate page from Metrics and Schemas

The metric catalog and the schemas are things you add to, correct, publish and version. Vocabularies are reference: they are what standards bodies say. They are loaded with Aber rather than edited, and there are more of them each time Aber adopts another standard. Keeping them apart keeps the pages you edit small, while the page you consult can grow. The Imported tab is the one place a vocabulary is added here, and only by an Administrator.

## What the states mean

A vocabulary here is a **local copy of a published set of terms**. It is loaded with Aber and updated only on purpose. So it says what the standard said when it was loaded, not what a live registry says this morning.

Using a term does not make a device conform to that standard. It records which term was meant, which would otherwise be lost. That is how two people reading the same metric name six months apart can find out whether they meant the same thing.
