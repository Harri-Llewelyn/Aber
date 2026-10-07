## What this page is for

This page lists every service Aber runs, what each one is for, and how to reach it. Use it to find where a service answers, such as which port Grafana is on, without searching a deployment file.

## What the controls do

- **The tabs** group the services by what they are for. **Applications & User Interfaces** holds the things with a front door. **Ingestion & Messaging** is the path a reading takes from a machine to the historian. **Data & Backend Infrastructure** is what the other two are built on.
- **Other Registered Services** holds any service whose type fits none of those three. It appears only while something is in it, because that is the sign of a type nobody expected. Any group with nothing in it has no tab.
- The `?` just after the tab names says what the open group is.
- **Service Name** and **Service Type** say what the service is. The type is a category in words, such as Edge node or REST API. Hover it to see the type the service was registered with.
- **Endpoint URL** is where the service answers, for the deployment you are actually running.
- **Version** is the image tag this release deploys for the service. It is shown without a leading `v`, so every row reads alike. Hover it for the full image reference, which is what a vulnerability scanner or a registry needs.
- The version is recorded from the deployment at each install and upgrade. So it shows what the release asked for, not what a container reports about itself. If it reads **not recorded**, the service is switched off in this deployment, or something other than the deployment registered it.
- **Liveness** says whether the service is answering now: **ACTIVE**, **DOWN** or **not observed**. The page reads again every 3 seconds, so it changes without a reload.
- **ACTIVE** and **DOWN** are observations, written every minute from the metrics store. ACTIVE means the metrics store checked the service and it answered; its tooltip gives the time. DOWN means it was checked and did not answer.
- **not observed**, in dim text rather than a badge, means nothing in Aber watches that service. That is not the same as healthy.
- **Reach** says **what can get to that service**, not only where it is. It is easy to miss. A service reachable only inside the cluster can look like one published to the network. They are not equally exposed, and this column says so rather than leaving you to assume.
- Reach **network**: published outside the cluster, through the Ingress or a LoadBalancer port.
- Reach **host only**: bound to 127.0.0.1, so reachable from the deployment host or through an SSH tunnel.
- Reach **internal**: not published outside the cluster. You reach it from inside the cluster, or through `kubectl port-forward`.
- Reach **not recorded**: nothing says where it can be reached from.
- Reach is recorded from the deployment at each install and upgrade. If an administrator turns a route on or off, the change shows here after the upgrade.
- The **Endpoint URL** follows from Reach. It is a link where your browser can open it. Where it cannot, it is a copy button, and its tooltip says why.

## What the states mean

A service is listed here because Aber knows it deploys it. Nothing on this page searches the network for services it was not told about. So an empty directory means nothing is registered, not that nothing is running.

The deployment registers the rows at each install and upgrade. You cannot add one here.

**Local identifiers are marked as local.** The directory can give service and schema identifiers to other systems. Aber creates those identifiers itself; they are not registered in a shared namespace. So each one is sent with a note saying it is local. Without that note, a local identifier could be mistaken for a shared one. That is how a claim that two systems work together becomes false.

## What this page cannot tell you

Whether a service is **healthy** in the sense that matters to its users. The page shows only whether it answers. A service that is up but answering wrongly looks the same here as one that is up and correct.

Whether a version is **current**. The page does not check for newer releases or known vulnerabilities. The services are built, tested and upgraded together, by upgrading Aber. So a newer version of one service is not, on its own, a reason to change it.
