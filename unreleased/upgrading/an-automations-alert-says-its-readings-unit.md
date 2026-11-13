### From 1.9.0, an automation's alert says the unit of its reading

An alert raised by an automation now says the unit of a measured reading, as History does. For a
temperature in `CELSIUS` it said "Lathe 3: Spindle/BEARING_TEMPERATURE is 82.5, above 80 for 5m". It now
says "Lathe 3: Spindle/BEARING_TEMPERATURE is 82.5 °C, above 80 °C for 5m". A percentage stands against
the number ("42%"), and a unit with no symbol is printed as its code.

This is the alert's `summary`: the bell, the alert counter, **History**'s Alerts tab, the **What** line
of an email and the `summary` of a webhook's message. Its `labels` and `values` are unchanged. The
metric is still its name, and `values.value` and `values.threshold` are still numbers.

If a script reads the number out of an automation alert's `summary`, read `values.value` instead. A
pattern such as `is ([0-9.]+),` no longer matches a reading that has a unit.

An alert that is firing when you upgrade keeps the text it started with. The next one says the unit.
