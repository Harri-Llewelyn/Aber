## Summary

Reference vocabularies: the published sets of terms that industrial standards define, so that a metric in this deployment can be labelled with the same name somebody else's system already uses. This page is reference you read, not state you edit.

## What the controls do

- **The four standard tabs** -- MTConnect, ISO 22400, OPC UA and ASHRAE 223P -- each show one standard's entries in the same card. Switching tab keeps the search text, so one query asks every standard.
- **The "?"** in the tab bar, after the last tab, says what the selected standard is and what to watch for in it.
- **Search** filters the selected standard by name and by the text shown on hover (an ISO 22400 KPI is found by its formula). A search opens the sections that match.
- **The sections** group each standard's entries: MTConnect's data item types, components, sub types and units, ISO 22400's KPI families, OPC UA's companion specifications and ASHRAE 223P's superclasses. They start collapsed. A header shows **N in use** when a catalog metric already uses N of its entries, and a **?** beside the title where the section needs explaining. A header stays at the top of the card while its entries scroll under it.
- **Expand all** opens every section of the selected standard, and reads **Collapse all** while any is open. Collapse all also closes the sections a search opened, and keeps the search.
- **Click an entry** to start a catalog metric from it; such an entry shows a **+** when you point at it or tab to it. It opens the Add Metric dialog on the Metrics page with the type, the semantic identifier and the reference type already filled in. That path exists because these identifiers are long, exact, and wrong in a way nothing notices if they are typed by hand. Only some entries can be clicked: MTConnect data item types (not components, sub types or units), every ISO 22400 KPI, every OPC UA data point, and ASHRAE 223P classes (not relations). Entries already in use are ticked and stay clickable. Clicking needs the Administrator role; without it the entries are read-only.

## Why this is a separate page from Metrics and Schemas

The catalog and the schema registry are state: things you add to, correct, publish and version. Vocabularies are reference: they are what standards bodies say, they arrive by seeding rather than by editing, and the set of them grows every time this stack adopts another standard. Keeping them apart means the page you edit stays small while the page you consult can grow.

## What the states mean

A vocabulary here is a **local copy of a published set of terms**. It is seeded with the platform and updated deliberately, so it says what the standard said when it was seeded -- not what a live registry says this morning.

Using a term does not make a device conform to that standard. It records which term was meant, which is the part that is otherwise lost, and it is the reason two people reading the same metric name six months apart can find out whether they meant the same thing.
