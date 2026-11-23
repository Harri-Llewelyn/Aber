### From 1.9.0, an AGV reading has a vocabulary

From 1.9.0, the Vocabulary page has a **VDA 5050** tab, and Add Metric has a **VDA 5050** standard. They
list the 24 readings an automated guided vehicle reports in the `state` message. One is the battery's
charge. Another says whether the vehicle is driving. The upgrade adds one table and one metric group, and
changes no metric. There is nothing to run.

- **The group `AGV` is registered.** A site that already made a group called `agv`, `Agv` or `AGV` keeps
  its own spelling. The upgrade registers nothing for it. A metric named `AGV/...` is accepted as before.
- **Your AGV metrics are not changed.** A Custom metric a site named by hand keeps its name and its
  readings. To name one after the vocabulary, add the new metric from the Vocabulary page and deprecate
  the old one. A metric's name cannot change.
- **A metric made from a field is named by its path.** `velocity.vx` becomes `AGV/velocity/vx`. The
  datatype, the semantic id and any fixed set of values are filled in. The unit is not: the VDA writes
  `m/s`, and a unit here is an MTConnect name.
- **A script that reads `/rest/v1/vda5050_vocabulary`** gets the 24 fields. Each has its path as `name`,
  its datatype and its semantic id. It has its unit and description where the schema gives them.
- **An AAS export** defines a concept carrying one of these ids by the schema's description of the field,
  where the schema gives one.
  i3X lists a new namespace, `https://aber.local/semantics/vda5050/v3.0`, once a metric carries one of the ids.
