Every service this stack runs, what it is for, and how to reach it. The page exists because the
answer to "which port is Grafana on" should not be a search through a compose file, and because on
Kubernetes there is no port to find at all.

## What the controls do

- **Service Name** and **Service Type** say what the service is. **Endpoint URL** is where it
  answers, resolved for the target you are actually running on.
- **Liveness** is whether it is answering now.
- **Reach** is the part that is easy to miss: it says **what can get to that service**, not only
  where it is. A database that answers only on the loopback interface and a database published to
  the network are the same URL and are not the same exposure, and this column is where that
  difference is stated rather than assumed.

## What the states mean

A service listed here is one this platform knows it deploys. Nothing on this page probes the network
for services it was not told about, so an empty directory means nothing is registered, not that
nothing is running.

**Local identifiers are marked as local.** The directory can serve service and schema identifiers to
other systems, and those identifiers are minted here rather than registered in a shared namespace.
The qualification travels with them: a consumer that receives one is told it is local, because a bare
identifier with the note stripped off is exactly how an interoperability claim becomes false.

## What this page cannot tell you

Whether a service is **healthy** in the sense that matters to its users -- only whether it answers.
A service that is up and answering wrongly looks the same here as one that is up and correct.
