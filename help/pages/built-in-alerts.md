## What this page is for

Aber raises alerts about itself. This page says what each one means and what to check first. The **Built-in** tab of the **Automations** page lists them all, and each alert's drawer links here.

These alerts are the ones this release of Aber ships. They are not the [automations](automations.md) your site writes. A rule someone added by hand in Grafana is not listed.

## How to read the Built-in tab

Open **Automations** in the sidebar, then the **Built-in** tab. Everyone who can sign in can read it. Nothing on it changes anything.

Each row is one alert:

- **Alert** is its name, with its rule's UID under it.
- **Group** is the kind of rule it belongs to.
- **Severity** says how urgent it is: critical, warning or info.
- **Subject** says what it is about: a gateway, a machine identity's token, or the platform as a whole.
- **Hold** is how long the condition must stay true before the alert fires. **None** fires at the first check.
- **Fires when** says in words what sets it off.
- **Evaluated by** says what checks the rule. Today that is Grafana.
- **State** says whether it is firing now.

The state is one of three:

- **Firing** has a count, such as **2 firing**. Each instance is one subject, such as one gateway.
- **Could not be evaluated** means Grafana could not run the rule's query. Aber cannot say whether the condition holds. Check what the rule reads, such as the database or the metrics store.
- **Not firing** means no open alert from this rule. It does not mean all is well. Aber cannot see whether Grafana checked the rule.

Select a row to open its drawer. The table then keeps only **Alert**, **Severity** and **State**, to fit beside it. The drawer shows the rule as its file writes it: the query, the threshold, the hold, the labels and the summary. It lists the rule's recent alerts. **View Help** opens the entry below. **View in Grafana** opens the rule in Grafana, in a new tab.

An alert about the platform opens its rule here, from the counter in the top bar or from a message. An alert about a gateway or a device opens that gateway or device. Its drawer has **View rule**, which opens the rule here.

Some alerts are raised for a site's own rules, which this release does not ship. Their link opens this tab with a note saying so.

## Platform Conditions

These alerts read the state Aber keeps about itself: gateways, backups, machine identities and the capture jobs.

### Gateway Stale

Rule UID: `aber-gateway-stale`.

A gateway has sent no heartbeat for over 90 seconds, and has stayed quiet for 5 minutes.

Check first:

1. Open **Gateways** and find the gateway. Its status reads **STALE** or **OFFLINE**.
2. Check that its computer has power and a network connection to Aber.
3. If it has both, follow the steps in [Remote gateways](../site/remote-gateways.md#troubleshooting).

### Enrolment Stuck

Rule UID: `aber-enrolment-stuck`.

A Remote gateway used its setup token over an hour ago and has not announced itself. Its status stays **AWAITING_BIRTH**. Its flow may not have deployed.

Check first:

1. On the appliance, read the Node-RED logs. The step is in [Remote gateways](../site/remote-gateways.md#troubleshooting).
2. A connection failure usually means the broker is unreachable, or the address it was given is wrong.
3. If it is still stuck, issue a new setup bundle from the gateway's drawer on **Gateways**.

### Quarantine Queue Depth

Rule UID: `aber-quarantine-depth`.

More than 5 devices have waited for a decision for 5 minutes. A device Aber does not recognise waits in quarantine until someone approves it. Its readings are dropped meanwhile.

Check first:

1. Open **Devices**, then the **Quarantine** tab.
2. Approve the devices that belong, and reject the rest.
3. Many at once usually means one gateway is misconfigured. On **Gateways**, the **Has quarantined devices** filter finds it.

### Gateway CA Expiring

Rule UID: `aber-gateway-ca-expiring`.

The certificate authority a gateway holds is within 30 days of expiry, or has expired. A gateway that cannot trust the broker's certificate cannot connect. Every gateway on the same authority stops at once.

Check first:

1. Open **Gateways** and read **CA Expires** in the Health block of the gateway's drawer.
2. Tell whoever runs the server. The internal certificate authority needs renewing before it expires.
3. Each gateway must receive the new root. The same row says when one has not yet.

### Service Token Expiring

Rule UID: `aber-service-token-expiring`.

A machine identity's token is close to expiry. When it expires, the client that uses it fails as if the server were broken. Only Administrators see this alert.

Check first:

1. Open **Access Control**, then **Machine identities**. The alert names the identity and the token.
2. Issue a new token, and put it in the client that uses it.
3. Revoke the old token. That clears the alert.

### Archive Backlog

Rule UID: `aber-archive-backlog`.

Readings that should be in the cold archive are more than 14 days overdue. The export to the archive has failed or stopped.

Check first:

1. Open **Cold Storage**. It says whether archiving is set up, and which chunks of readings are verified.
2. Check that the destination is reachable and its credential is still valid.
3. Until it is fixed, the historian's disk keeps filling. Watch **Host Disk Filling**.

### Backup Stale

Rule UID: `aber-backup-stale`.

No platform backup has succeeded for 36 hours. A restore can only go back to the last good backup.

Check first:

1. Open **Backups**. A failed backup shows its reason.
2. Select **Take a backup** and watch the result.
3. If no backup ever starts, the backup service may not be running. Tell whoever runs the server.

### Off-site Backup Stale

Rule UID: `aber-backup-offsite-stale`.

The newest backup has had no copy at the off-site destination for 12 hours. Copies that fail are retried quietly, so this alert is the notice.

Check first:

1. Open **Backups**. The **Off site** column says **Copied**, **Waiting** or **Failed, retrying** for each backup. A failed copy has the store's reason in its tooltip.
2. Check that the destination is reachable from the server and its credential is still valid.
3. If the network has an egress rule, check that it allows the destination.

### Capture or Playback Failed

Rule UID: `aber-job-failed`.

A capture or a playback ended as failed in the last hour. The alert clears by itself an hour later.

Check first:

1. Open **Capture**. The job's tab, **Captures** or **Playbacks**, says why it failed.
2. A device that sent nothing fails its recording. The reason names the IDs it listened for. Compare them with the ID the device publishes under.
3. Start the job again once you have fixed the cause.

### Capture or Playback Stuck

Rule UID: `aber-job-stuck`.

A capture or a playback is still queued, recording or running, five minutes past what its limits allow. A stuck recording blocks every other recording.

Check first:

1. Open **Capture**. The job shows above the list.
2. Select **Stop**. It ends any job this alert reports.
3. If it keeps happening, tell whoever runs the server.

### Playback Worker Not Reporting

Rule UID: `aber-playback-worker-stale`.

A playback is queued or running, but the playback worker has not reported for over two minutes. The worker is the program that publishes the recording.

Check first:

1. Tell whoever runs the server. The playback worker has stopped, or was never switched on for this site.
2. Select **Stop** on **Capture** to clear the waiting playback.
3. Start it again once the worker is back.

## Ingestion Pipeline

These alerts watch the path a reading takes from the broker to the historian. A quiet plant and a broken pipeline look alike on the History page, so these read the ingestion service's own counters.

### Ingestion Consuming Nothing

Rule UID: `aber-ingestion-silent`.

The ingestion service has recorded no messages for 10 minutes, though devices should be publishing. It also fires when the service cannot be reached at all.

Check first:

1. Open **System**, then **Ingestion & Messaging**. Check that the ingestion service and the broker are up.
2. Check **Gateways**. If every gateway is offline, the cause is the broker or the network.
3. If the service is up and the gateways are online, read the service's logs on **System**. Logs are for Administrators.

### Telemetry Being Dropped

Rule UID: `aber-ingestion-drops`.

The ingestion service has turned messages away for 5 minutes. The alert names the reason. Under report-by-exception, nothing sends a dropped reading again.

Check first:

1. Read the reason in the alert's summary.
2. The **Messages lost, last hour** figure on **System**, **Ingestion & Messaging**, shows the count.
3. The [ingestion service's README](../../ingestion/README.md) lists every reason and what it means.

### Gateway Binding Rejections Rising

Rule UID: `aber-ingestion-binding-rejections`.

Something has published readings for a device it does not own, for 15 minutes. Aber refused them, so nothing is corrupted. A misconfigured gateway and forged readings look the same here.

Check first:

1. Find the gateway. Its flow may be publishing under another gateway's device names.
2. On **Access Control**, check which gateway holds each broker credential.
3. If no gateway of yours is the cause, treat it as forged traffic. Tell whoever runs the server.

### Ingestion Dropping Birth Certificates

Rule UID: `aber-ingestion-birth-drops`.

The ingestion service refused a birth certificate because it could not reach the directory, for 5 minutes. A birth certificate tells Aber what a device publishes. A device whose birth was dropped sends readings Aber cannot decode.

Check first:

1. Open **System** and check that the platform database is up.
2. Once it answers, the affected gateways send their births again at their next rebirth timer.
3. Do not wait for it. On **Gateways**, select **Request Rebirth** in the gateway's drawer.

### Audit Trail Partitions Falling Behind

Rule UID: `aber-audit-trail-partitions`.

Audit Trail rows have been landing in a catch-all partition for 30 minutes. The nightly job that prepares next month's partition has stopped. No row is lost.

Check first:

1. Tell whoever runs the server. The nightly job in the platform database needs a look.
2. Nothing is lost while it is stopped. A catch-all partition takes the rows, so no write fails.

### Historian Unreachable From Ingestion

Rule UID: `aber-ingestion-db-down`.

The ingestion service holds no connection to the historian, and messages are arriving. It holds what arrives in a queue. After about 2 minutes, a busy site's queue may be full, and readings are lost.

Check first:

1. Open **System** and check that the historian is up.
2. A full disk stops it. Look for **Host Disk Filling** and **Volume Filling**.
3. If the historian is up, read the ingestion service's logs on **System**. Logs are for Administrators.

### Historian Unreachable From Ingestion (No Traffic)

Rule UID: `aber-ingestion-db-unreachable-idle`.

The ingestion service has failed to reach the historian for 10 minutes, and nobody is publishing. Nothing is lost yet. It becomes the alert above the moment a gateway publishes.

Check first: the same as for **Historian Unreachable From Ingestion**. Fix it before the plant starts up.

### Sparkplug Message Loss

Rule UID: `aber-ingestion-sequence-gaps`.

One gateway's messages have had gaps for 15 minutes. Each gateway numbers its messages, and some numbers never arrived. Those readings are lost.

Check first:

1. Check the gateway's network. A flapping connection is the usual cause.
2. Check **Broker Shedding Messages**. If it fires too, the loss is on Aber's side.
3. If one gateway shows gaps and the others do not, the problem is that gateway.

### Readings Refused for Their Timestamp

Rule UID: `aber-ingestion-timestamps-refused`.

Aber refused readings from one gateway because their timestamps were wrong. They were too far ahead, too old, or older than a replay may be. Those readings were not recorded.

Check first:

1. Check the gateway's clock. See **Gateway Clock Skew** below.
2. A replay older than the platform keeps comes from an outage longer than the limit.
3. The reason is in the alert. [Remote gateways](../site/remote-gateways.md#late-data-after-an-outage) says how late data is handled.

### Gateway Outage Lost Readings

Rule UID: `aber-gateway-outage-loss`.

A gateway reported an outage in which some readings were dropped, and they were never recorded. The alert stays for an hour after the report.

Check first:

1. Read the gateway's outage in [Remote gateways](../site/remote-gateways.md#troubleshooting).
2. Check that the gateway buffers its readings during an outage.
3. If the buffer filled, give the appliance a larger one, if it has the disk.

### Late Replay Missing From the Rollups

Rule UID: `aber-ingestion-rollup-windows-failed`.

Readings that arrived late are stored, but the summaries behind the History charts lack them. A chart shows a gap where the readings are. Nothing is lost from the raw readings.

Check first:

1. Read the ingestion service's logs on **System**. They name the cause.
2. Ask for the summaries to be refreshed for that window. [Remote gateways](../site/remote-gateways.md#late-data-after-an-outage) says how.

### Gateway Clock Skew

Rule UID: `aber-gateway-clock-skew`.

A gateway's clock differs from Aber's by more than 60 seconds, for 15 minutes. It looks online, but it files every reading at a time that never happened.

Check first:

1. Check the appliance's date and time.
2. Check that it keeps time with a time server.
3. Fix it before the difference grows. Readings far from the true time are refused.

### Historian Writer Saturating

Rule UID: `aber-ingestion-writer-saturating`.

The ingestion service's writer has spent over half its time writing to the historian, for 10 minutes. It still keeps up, but there is little room left.

Check first:

1. A gateway sending a backlog after an outage is normal. Wait and see if it falls.
2. If it stays high, check **Node CPU Saturated** and **Host Disk Filling**. A slow historian is the usual cause.
3. If messages are dropped, **Telemetry Being Dropped** fires next.

### Broker Shedding Messages

Rule UID: `aber-broker-shedding`.

The broker has discarded messages because a subscriber could not keep up. A discarded message never reaches the ingestion service, so no other alert sees it.

Check first:

1. Check that the ingestion service is up on **System**.
2. Check **Historian Writer Saturating**. A slow writer is the usual cause.
3. **Sparkplug Message Loss** firing too places the loss between the broker and the historian.

## Log Pipeline

The logs are the evidence for every other fault, so these alerts watch the system that collects them. An alert here costs you the record, not the readings.

### Log Collector Down

Rule UID: `aber-log-collector-down`.

The program that collects logs is not running. No new log lines are kept. Readings are not affected.

Check first:

1. Tell whoever runs the server. The collector needs restarting.
2. Lines written while it is down are not kept.

### Log Collection Stalled

Rule UID: `aber-log-collection-stalled`.

The collector is running but has sent no log lines for 15 minutes. Aber logs about itself every minute, so a quiet quarter hour is a fault.

Check first:

1. Open the **Logs** tab on **System**. It stops at the time the lines stopped.
2. Tell whoever runs the server. The usual cause is that the collector lost permission to read the containers' logs.

### Log Store Refusing Lines

Rule UID: `aber-log-store-refusing`.

The log store is turning lines away for 10 minutes. It has a limit on how fast lines arrive, and how many streams it holds. Lines refused now are lost.

Check first:

1. Look for a service writing far more than usual. A fault often does.
2. Fix that service, and the refusals stop.
3. If nothing is at fault, tell whoever runs the server. The limits may be too low for your site.

### Log Forward Failing

Rule UID: `aber-log-forward-failing`.

The copy of the logs sent to your site's own log store is failing, for 15 minutes. It is optional, so this alert only fires where you switched it on. Aber's own log store is not affected.

Check first:

1. Check that the destination is reachable from the server.
2. Check its credential.
3. If the network has an egress rule, check that it allows the destination.

## Host

### Host Disk Filling

Rule UID: `aber-host-disk-filling`.

The server's main disk has under 15% free, for 15 minutes. The databases, the metrics store and the log store all write to it. When it fills, they stop together.

Check first:

1. Tell whoever runs the server. Find what is growing. The historian's readings, backups and logs are the usual causes.
2. Free space or add disk before it fills.
3. **Cold Storage** says how long the historian keeps raw readings, and whether older ones are archived.

## Cluster

These alerts read what the server reports about its containers and its volumes. Each is about one container, claim or node, and its summary names it.

### Container Near Memory Limit

Rule UID: `aber-cluster-container-memory`.

A container has used over 90% of its memory limit for 10 minutes. At 100% the system stops it and starts it again, and what it held in memory is lost.

Check first:

1. Find the container in the summary.
2. A short peak is normal. Memory that only grows is a leak.
3. Tell whoever runs the server. The container's memory limit may need raising.

### Container Restarting

Rule UID: `aber-cluster-container-restarting`.

A container has started more than twice in an hour. An upgrade starts each container once. A crash loop starts it many times.

Check first:

1. Find the container in the summary.
2. Read its last log lines on **System**. Logs are for Administrators. They say why it stopped.
3. If it follows an upgrade, wait a few minutes first.

### Volume Filling

Rule UID: `aber-cluster-volume-filling`.

A storage volume is over 85% full, for 15 minutes. The service that writes to it will stop when it fills.

Check first:

1. Find the volume in the summary.
2. Find what is growing. The historian's readings and the log store are the usual causes.
3. Enlarge the volume, or free what fills it. Tell whoever runs the server.

### Node Memory Pressure

Rule UID: `aber-cluster-node-memory`.

The server has under 10% of its memory available, for 10 minutes. Below that, the system starts stopping containers.

Check first:

1. Find which containers use the most, with whoever runs the server.
2. Check that no container is growing without limit. See **Container Near Memory Limit**.
3. If the server is simply too small, add memory.

### Node CPU Saturated

Rule UID: `aber-cluster-node-cpu`.

The server's processors have been over 90% busy for 15 minutes. Nothing fails. Everything slows, and the ingestion writer slows first.

Check first:

1. Find which containers are busiest, with whoever runs the server.
2. Check **Historian Writer Saturating**. It fires next if the writer falls behind.
3. A backlog being replayed after an outage is a short load. A load that stays needs a larger server.

## Databases

These alerts read the two databases: the platform database and the historian. The summary says which. They need the databases' metrics, which a site can switch off.

### Database Connections Near Limit

Rule UID: `aber-db-connections`.

A database has used over 80% of the connections it allows, for 5 minutes. At the limit it refuses new connections, and every client sees it at once.

Check first:

1. Find the database in the summary.
2. Look for a client that opens many connections and never closes them.
3. Tell whoever runs the server. A pool that does not drain by itself needs a restart.

### Database Deadlocks

Rule UID: `aber-db-deadlocks`.

Two transactions waited for each other, and the database cancelled one. This happened in the last 10 minutes. The database counts it as solved, so only the client saw an error.

Check first:

1. One deadlock is harmless. The client can try again.
2. If it repeats, read the database's logs for the statements. Logs are for Administrators, on **System**.
3. Tell whoever changed the software last.

### Transaction ID Wraparound Approaching

Rule UID: `aber-db-wraparound`.

A database's transaction age is over 1,000,000,000. At about 2,100,000,000 it stops accepting writes, and it takes hours to bring back. This takes days to reach, so it is entirely preventable.

Check first:

1. Tell whoever runs the server today. The alert fires early on purpose.
2. They should check that the database's automatic cleanup is running.
3. A long-running transaction or an abandoned replication slot is the usual cause.

### Historian Policy Job Failing

Rule UID: `aber-db-historian-job-failing`.

One of the historian's background jobs failed in the last hour. These jobs compress old readings, remove expired ones and refresh the summaries behind the History charts. The alert names the job.

Check first:

1. Read the historian's logs on **System**. Logs are for Administrators.
2. A retention job that stops lets the disk grow. A refresh job that stops leaves the History charts behind.
3. Tell whoever runs the server. It needs fixing before the disk fills.

### Database Not Answering

Rule UID: `aber-db-not-answering`.

A database has not answered its health check for 5 minutes. It is down, starting, recovering, or refusing connections.

Check first:

1. Open **System** and check the database.
2. Look for **Host Disk Filling**, **Volume Filling** and **Database Connections Near Limit**.
3. If it does not come back, tell whoever runs the server at once.

### Database Collector Failing

Rule UID: `aber-db-collector-failing`.

The program that measures a database has a collector that has failed for 10 minutes. The panels and alerts that use its figures go empty, and read as if all were well. This alert is the only sign.

Check first:

1. The alert names the collector.
2. Tell whoever runs the server. The cause is a setting or a missing permission.
3. Until it is fixed, the other database alerts may be blind.

### Historian Backup Stale

Rule UID: `aber-db-historian-backup-stale`.

The historian has had no successful physical backup for 36 hours. It fires only where the historian's own backup is switched on.

Check first:

1. Open **Backups** and read the historian's card.
2. Select **Take a backup**. The card shows the result.
3. Check **Historian WAL Archiving Failing**. A broken repository causes both.

### Historian WAL Archiving Failing

Rule UID: `aber-db-historian-wal-archiving`.

The historian could not copy its write-ahead log to the backup repository, for 10 minutes. The log fills the disk meanwhile. At its limit, the oldest is dropped, and a restore can no longer cross that gap.

Check first:

1. Check that the backup repository is reachable and its credential is valid.
2. Once it is, the backlog is copied by itself.
3. If the disk is also filling, see **Volume Filling**.

### Platform Database Backup Stale

Rule UID: `aber-db-platform-backup-stale`.

The platform database has had no successful physical backup for 36 hours. It is the same alert as **Historian Backup Stale**, for the other database. It fires only where the platform database's own backup is switched on.

Check first: the same as for **Historian Backup Stale**. Read the platform database's card on **Backups**.

### Platform Database WAL Archiving Failing

Rule UID: `aber-db-platform-wal-archiving`.

The platform database could not copy its write-ahead log to the backup repository, for 10 minutes. It is the same alert as **Historian WAL Archiving Failing**, for the other database.

Check first: the same as for **Historian WAL Archiving Failing**. A full disk stops the platform database too.
