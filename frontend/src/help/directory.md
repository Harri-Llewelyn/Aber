## Summary

Every service this stack runs, what it is for, and how to reach it. The page exists because the answer to "which port is Grafana on" should not be a search through a deployment file, and because on Kubernetes there is no port to find at all.

The services are grouped by what they are for, one tab each: **Applications & User Interfaces** (the things with a front door), **Ingestion & Messaging** (the path a reading takes from a machine to the historian) and **Data & Backend Infrastructure** (what the other two are built on). A service of a type none of those claims lands in **Other Registered Services**, a tab that appears only while something is in it, because it is the sign of a type nobody anticipated. A group with nothing in it has no tab. The `?` at the start of the row under the tabs says what the open group is. The page reads again every 3 seconds, so **Liveness** changes without a reload.

## What the controls do

- **Service Name** and **Service Type** say what the service is. The type is a category in words, such as Edge node or REST API; hover it for the type it was registered with. **Endpoint URL** is where it answers, resolved for the target you are actually running on.
- **Version** is the image tag this release deploys for the service. It is shown without a leading `v`, so every row reads alike; hover it for the full image reference, which is what a vulnerability scanner or a registry needs. It is recorded from the deployment at each install and upgrade, so it shows what the release asked for, not what a container reports about itself. **not recorded** means the service is switched off in this deployment, or something other than the deployment registered it.
- **Liveness** is whether it is answering now, as **ACTIVE**, **DOWN** or **not observed**. ACTIVE and DOWN are observations, written every minute from the metrics store: ACTIVE means it was scraped successfully, and its tooltip gives the time; DOWN means it was scraped and did not answer. **not observed**, in dim text rather than a badge, means nothing in the stack watches that service, which is not the same as healthy.
- **Reach** is the part that is easy to miss: it says **what can get to that service**, not only where it is. A database that answers only on the loopback interface and a database published to the network are the same URL and are not the same exposure, and this column is where that difference is stated rather than assumed. It reads **network** (published on every interface), **host only** (bound to 127.0.0.1, so the deployment host or an SSH tunnel), **internal** (no host port, so reachable only from inside the container network) or **not recorded**. The endpoint follows it: a link where your browser can open it, and a copy button where it cannot, with the reason in its tooltip.

## What the states mean

A service listed here is one this platform knows it deploys. Nothing on this page probes the network for services it was not told about, so an empty directory means nothing is registered, not that nothing is running.

**Local identifiers are marked as local.** The directory can serve service and schema identifiers to other systems, and those identifiers are minted here rather than registered in a shared namespace. The qualification travels with them: a consumer that receives one is told it is local, because a bare identifier with the note stripped off is exactly how an interoperability claim becomes false.

The rows are registered by the deployment at each install and upgrade, not added here.


## What this page cannot tell you

Whether a service is **healthy** in the sense that matters to its users -- only whether it answers. A service that is up and answering wrongly looks the same here as one that is up and correct.

Whether a version is **current**. The page does not check for newer releases or known vulnerabilities. The services are built and tested together and are upgraded together, by upgrading Aber, so a newer version of one service is not on its own a reason to change it.
