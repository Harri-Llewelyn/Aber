## What this page is for

This page lists every service Aber runs, what each one is for, whether it is up, and how to reach it. Use it to find where a service answers, such as which port Grafana is on, without searching a deployment file.

The **Ingestion & Messaging** tab also shows what the stack is doing now: messages arriving, readings written, messages lost, and gateways and devices reporting. See [The figures on Ingestion & Messaging](#the-figures-on-ingestion--messaging).

## What the controls do

- **The tabs** group the services by what they are for. **Applications & User Interfaces** holds the things with a front door: a link there is where you go to do something the dashboard does not do itself. **Ingestion & Messaging** is the path a reading takes from a machine to the historian. If telemetry has stopped arriving, the fault is almost always one of these. **Data & Backend Infrastructure** is what the other two are built on. It is listed so that this page does not make the stack look smaller than it is.
- **Other Registered Services** holds any service whose type fits none of those three. It appears only while something is in it, because that is the sign of a type nobody expected. Any group with nothing in it has no tab.
- Point at a tab, or move to it with the keyboard, to read what its group holds.
- **Service Name** and **Service Type** say what the service is. The type is a category in words, such as Edge node or REST API. Hover it to see the type the service was registered with.
- **Endpoint URL** is where the service answers, for the deployment you are actually running.
- **A column's heading sorts the table** by that column, on every tab. Click it again to reverse the order, and a third time to go back to the usual order. A status sorts the most serious first, and an empty cell always sorts last. The page's address keeps the order, so a link or a reload shows the table the same way.
- **Version** is the image tag this release deploys for the service. It is shown without a leading `v`, so every row reads alike. Hover it for the full image reference, which is what a vulnerability scanner or a registry needs.
- Some images are built by Aber from another product, such as Node-RED. For those, Version shows the product's version, not Aber's. The tooltip still gives the full image reference.
- The version is recorded from the deployment at each install and upgrade. So it shows what the release asked for, not what a container reports about itself. If it reads **not recorded**, the service is switched off in this deployment, or something other than the deployment registered it.
- The badge after a version counts the known vulnerabilities in that image that have a fix: **fixable HIGH and CRITICAL** ones. Red means at least one is CRITICAL. Hover it for the counts and the date, such as "3 fixable HIGH, as of 2026-10-02".
- The count is from the scan made when the release was built. A vulnerability published after that date is not counted, so a zero means none were known on that date.
- **not scanned**, in dim text, means the release did not scan that exact image. Usually the deployment sets its own image tag for that service. That is not the same as zero. A build that is not a release reads **not scanned** on every row.
- A count is not a reason to change one service's image on its own. The fix arrives as a new Aber release, which upgrades the services together.
- **Liveness** says whether the service is answering now: **ACTIVE**, **DOWN** or **not observed**. The page reads again every 3 seconds, so it changes without a reload.
- **ACTIVE** and **DOWN** are observations, written every minute from the metrics store. ACTIVE means the metrics store checked the service and it answered; its tooltip gives the time. DOWN means it was checked and did not answer.
- **not observed**, in dim text rather than a badge, means nothing in Aber watches that service, or the metrics store did not answer its last check. That is not the same as healthy.
- **Reach** says **what can get to that service**, not only where it is. It is easy to miss. A service reachable only inside the cluster can look like one published to the network. They are not equally exposed, and this column says so rather than leaving you to assume.
- Reach **network**: published outside the cluster, through the Ingress or a LoadBalancer port.
- Reach **host only**: bound to 127.0.0.1, so reachable from the deployment host or through an SSH tunnel.
- Reach **internal**: not published outside the cluster. You reach it from inside the cluster, or through `kubectl port-forward`.
- Reach **not recorded**: nothing says where it can be reached from.
- Reach is recorded from the deployment at each install and upgrade. If an administrator turns a route on or off, the change shows here after the upgrade.
- The **Endpoint URL** follows from Reach. It is a link where your browser can open it. Where it cannot, it is a copy button, and its tooltip says why.

## The figures on Ingestion & Messaging

The Ingestion & Messaging tab opens with a row of figures. They answer "is data flowing?" without leaving the dashboard. Each one is the latest value only. Point at a figure to read what it counts.

- **Messages received** is how many Sparkplug messages the ingestion service handled each second, averaged over the last 5 minutes. Its tooltip splits it by message type, such as DDATA.
- **Readings written** is how many readings the ingestion service wrote to the historian each second, over the same 5 minutes. A reading is one value of one metric.
- **Messages lost, last hour** shows three numbers. **refused** counts messages the ingestion service turned away. **shed** counts messages the broker dropped because a subscriber was too slow. **missed** counts gaps in the Sparkplug sequence numbers.
- The three overlap, so they are never added up. A message the broker shed also shows up as missed. The tooltip names the most common reason for a refusal.
- **Ingestion links** says whether the ingestion service is subscribed to the broker and connected to the historian. If either one is not connected, readings are not being recorded, and the figure turns red.
- **Gateways online** counts the gateways online now, out of those enrolled. Archived gateways, the Playback gateway and gateways still awaiting setup are not counted.
- **Devices reporting** counts the devices that sent at least one reading in the last 5 minutes.
- The first four come from the metrics store and change once a minute. The last two are counted from the databases each time the page reads.
- **not observed**, in dim text, means there is no fresh value. Aber shows that rather than an old number or a zero. Usually the metrics store did not answer, or it is not installed.
- **Devices reporting** reads **not observed** when the historian cannot be reached. The gateway count still shows.
- **Click a figure to open its history in Grafana**, in a new tab. Messages received and Ingestion links have no Grafana panel, so they open nothing.
- A figure opens nothing either when your browser cannot reach Grafana, for example when Grafana is published only on the deployment host.

## What the states mean

A service is listed here because Aber knows it deploys it. Nothing on this page searches the network for services it was not told about. So an empty page means nothing is registered, not that nothing is running.

The deployment registers the rows at each install and upgrade. You cannot add one here.

**Local identifiers are marked as local.** Aber's [Factory+](../guides/glossary.md#factory) Directory can give service and schema identifiers to other systems. Aber creates those identifiers itself; they are not registered in a shared namespace. So each one is sent with a note saying it is local. Without that note, a local identifier could be mistaken for a shared one. That is how a claim that two systems work together becomes false.

## What this page cannot tell you

Whether a service is **healthy** in the sense that matters to its users. The page shows only whether it answers. A service that is up but answering wrongly looks the same here as one that is up and correct.

Whether a version is **current**. The page does not check for a newer version of each service. The services are built, tested and upgraded together, by upgrading Aber. So a newer version of one service is not, on its own, a reason to change it. If the deployment turns on the release check, the account menu says when a newer Aber release exists.

How a figure has **changed over time**. The figures are the latest values only. Their history is in Grafana.

Whether a vulnerability was **published since the release**. The counts are as of the release's scan, and nothing on this page fetches a later one.
