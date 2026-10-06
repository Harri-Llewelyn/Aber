## What this page is for

This page holds reference vocabularies: the published sets of terms that industrial standards define. Use them to label a metric in this deployment with the same term somebody else's system already uses. This page is for reading; nothing here is edited.

## What the controls do

- **The four standard tabs**, MTConnect, ISO 22400, OPC UA and ASHRAE 223P, each show one standard's entries in the same card. Switching tab keeps the search text, so the same search can be tried on each standard in turn.
- **The "?"** in the tab bar, after the last tab, says what the selected standard is and what to watch for in it.
- **Search** filters the selected standard by name and by the text shown on hover. For example, an ISO 22400 KPI is found by its formula. A search opens the sections that match.
- **The sections** group each standard's entries. MTConnect has data item types, components, sub types and units. ISO 22400 has KPI families, OPC UA has companion specifications, and ASHRAE 223P has superclasses. Sections start collapsed.
- A section header shows **N in use** when catalog metrics already use N of its entries. Where a section needs explaining, a **?** sits beside its title. A header stays at the top of the card while its entries scroll under it.
- **Expand all** opens every section of the selected standard, and reads **Collapse all** while any is open. Collapse all also closes the sections a search opened, and keeps the search.
- **Click an entry** to start a catalog metric from it. An entry you can click shows a **+** when you point at it or tab to it. It opens the Add Metric dialog on the Metrics page, with the type, the semantic identifier and the reference type already filled in.
- This saves typing the identifiers by hand. They are long and exact, and a typing mistake in one goes unnoticed.
- Only some entries can be clicked. In MTConnect, these are data item types, not components, sub types or units. Every ISO 22400 KPI and every OPC UA data point can be clicked. In ASHRAE 223P, classes can be clicked, but relations cannot.
- Entries already in use are ticked, and you can still click them. Clicking needs the Administrator role; without it the entries are read-only.

## Why this is a separate page from Metrics and Schemas

The metric catalog and the schemas are things you add to, correct, publish and version. Vocabularies are reference: they are what standards bodies say. They are loaded with Aber rather than edited, and there are more of them each time Aber adopts another standard. Keeping them apart keeps the pages you edit small, while the page you consult can grow.

## What the states mean

A vocabulary here is a **local copy of a published set of terms**. It is loaded with Aber and updated only on purpose. So it says what the standard said when it was loaded, not what a live registry says this morning.

Using a term does not make a device conform to that standard. It records which term was meant, which would otherwise be lost. That is how two people reading the same metric name six months apart can find out whether they meant the same thing.
