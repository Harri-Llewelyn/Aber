## What this page is for

Use this page to take a backup of the whole of Aber without a shell. It also shows every backup run: what it stored, or why it failed.

A backup holds both databases and the key their Vault secrets are encrypted under. (The Vault is where Aber keeps its secrets.) It also holds the stored files: 3D models, area plans, broker captures and export bundles. Then come the forge, the broker's accounts and, where Aber issues its own certificates, the internal CA. The backup service writes all of it onto its own volume.

This page does not make backups itself. **Take a backup** queues a request, and the backup service does the work. So a backup shows as queued, then running, then as a run in the list that either completed or failed.

**The historian in a backup holds raw telemetry for the raw window (14 days unless the site changed it) and the 1-minute, 5-minute and 1-hour rollups.** The historian is the database that stores readings, and rollups are its summaries. Raw readings older than the window are only on cold storage, which no backup includes.

**Where the historian has its own physical backup, it is not in these.** A physical backup is a copy of the database's files. The components then list no historian. Instead the historian backs itself up daily, and archives every change in between. So it can be restored to any moment, not just to the last backup. The **Historian** line above the list shows that backup; see **The historian's own backup** below.

## What the controls do

- **Take a backup** queues one now. The note you add is kept with the backup. It is what you read when choosing a backup to restore from, so say why you took it.
- Where the historian has its own backup, **Take a backup** also asks it for a differential. That is a backup of what changed since its last full one. So one press satisfies both stale-backup alerts.
- **Cancel** withdraws a request the service has not yet picked up. A running backup cannot be cancelled: it finishes or fails.
- **Release** lets the retention window apply to a backup taken on request. Nothing is deleted at that moment. The service prunes it on its next pass, but only once it is older than the window and not one of the newest three.
- **Set a destination**, beside **Take a backup**, opens the off-site destination dialog. It holds the S3 endpoint, region, bucket, key prefix, access key ID and secret key. It also holds the age public key that every file is encrypted to (age is an encryption tool).
- **Address the bucket by path** is for MinIO and most self-hosted stores. Leave it off for AWS, R2 and B2.
- **Remove the destination** stops the copies and deletes the secret key. Copies already made stay in the bucket.
- **The filter** shows every run, or only the completed ones, or only the failed ones. A cancelled run is listed under all runs only.
- The list shows the newest 30 runs that match the filter. The foot says how many are loaded, such as `30 of 57`, beside **Show 27 more**. That adds older runs, up to 30 at a time. At the end it says **All 57 shown.**
- **A run** opens its panel when you select anywhere on its row, or press Enter or Space on it. The panel shows the whole of any failure, and when the run was queued, started and finished. For a backup, it shows where its files are, each file with its size, and its off-site copy. **Release** is there too, on a pinned backup.

## Whether backups are working now

One line above the list answers this. It appears only when the answer is no:

- **The last backup failed**, and none has succeeded since. The line says when the last good backup was taken. A failure followed by a success is history: it stays in the list, and the line goes.
- **No backup has succeeded in 36 hours**, so the nightly schedule has missed a night. A stopped backup service looks like this too, because a service that is not running records no failure. Before the first success, the hours count from the first backup queued.

Either line clears itself at the next successful backup. If the backup service has never run, there is nothing to report, and the page says no backups exist yet. The Grafana alert **Backup Stale** fires on the same 36 hours. So the problem reaches the alert counter in the top bar without anyone opening this page.

**A scheduled backup missed while Aber was off is taken late, once.** If no scheduled backup was queued in the last 25 hours, the service queues one as soon as it is running. So if Aber is switched off overnight, it takes its backup when it is next up. That backup is listed as **Scheduled**, at the time it was taken. If a late backup fails, it is not tried again before the next night, and the line above reports it.

## The historian's own backup

Where the historian has its own physical backup, a **Historian** line sits above the list. It shows:

- **the last backup**, as an age, with its type (full or differential) and the label the backup tool gave it.
- **when the next one is due**. It runs daily at the hour the site set. It is a full backup on its weekday, or whenever the newest full one is over a week old, and a differential otherwise.
- **Due now** means a night was missed, for instance while Aber was off, and the historian is about to take it.
- **how much the repository holds**: every backup it keeps, not counting the archived changes.
- **a backup asked for here**. It is **queued** until the historian picks it up, which it does within a minute. Then it is **being taken**, and then **taken** or **failed**.
- **Not picked up** means the historian's backup container is not running.

Select the line for its panel. It shows the label, the schedule and, after a failure, the whole of the reason.

A line above it appears only when the answer is no. It uses the same 36 hours as the main backup:

- **The historian's last backup failed**, and none has succeeded since. The line gives the start of the reason.
- **No historian backup has succeeded in 36 hours**. Before the first success, the hours count from when its backup was switched on.
- **The historian cannot be read**, when its database does not answer. The page then cannot tell whether its backup works, and says so rather than showing nothing.

**Take a backup** does not wait for the historian. The main backup completes on its own, and the Historian line shows the request and then its result. The Grafana alert **Historian Backup Stale** fires on the same 36 hours. Restoring the historian is done from a shell, following the runbook.

## The platform database's own backup

Where the platform database has its own physical backup too, a **Platform database** line sits above the Historian line. The platform database holds everything but the readings: the assets, the accounts, the settings and the audit trail.

- The line shows the same things as the Historian line: the last backup, when the next is due, and how much the repository holds.
- It has no request. **Take a backup** already includes the platform database, so it asks this backup for nothing.
- The warnings are the historian's: **The platform database's last backup failed**, and **No platform database backup has succeeded in 36 hours**. The Grafana alert **Platform Database Backup Stale** fires on the same 36 hours.

With this backup the platform database can be restored to any moment, not just to the last backup. Restoring it is done from a shell, following the runbook.

## What the list shows

The list shows every run the service has finished, newest first. Runs are never deleted, so the list is the full history.

- A **completed** run shows its backup. That is when it was taken, the stamp its files carry, its **Origin** (on request or scheduled), its size, what it holds and its retention.
- **Holds** names each component: the platform database, the historian, the Vault root key, the stored files, the forge, the broker accounts and the internal CA. The run's panel lists each file and its size.
- Once the retention window has pruned a backup, its run stays and says **Pruned by the retention window** under its status. Its files are gone.
- A **failed** run shows the reason the service gave under its status, cut to one line. Its panel has the whole reason. A failed backup leaves no files behind.
- A **cancelled** run was withdrawn before the service picked it up, and says so under its status.
- A run with no backup shows a dash in **Size**, **Holds**, **Retention** and **Off site**.

If a **queued** backup stays queued, no backup service is running: the `backup-service` Deployment is down. Cancel the backup or start the service. Only one backup runs at a time, so a queued one blocks the next.

A backup taken **on request** is **pinned**. The retention window does not apply to it until it is released. A backup taken **on the schedule** is pruned once it is older than the window, **except that the newest three backups are always kept**, whatever their age. While backups are failing, those three are the last good ones. So a run of failures longer than the window cannot prune them.

The **Retention** column says:

- **Pinned** on a backup taken on request.
- **Kept: one of the newest three** on a backup older than the window that is still kept for that reason.
- **Kept: pruning is off** when the site set the retention window to 0 days.
- **Released**, with the date, once a pinned backup was released.

## The off-site copy

The backup volume is usually on the same disk as both databases. So on its own, it protects you from a dropped table, but not from losing a disk, a node or the site. With a destination set, the backup service copies every backup to the S3 bucket, and keeps the local one.

Each file is encrypted with age before it leaves the service, to the public key you entered. So neither the bucket's credential nor the service can read a copy. Only the matching identity (the private key) can decrypt it.

- **The destination button** in the header says whether copies are made. While there is no off-site copy it reads **Set a destination**. While the destination is missing a field it reads **Complete the destination**. Both are amber with a warning icon, and say what is missing. Once copies can be made it reads **Change destination**, and its tooltip names where they go.
- **The Off site column** says, for each backup, **Copied**, **Waiting** or **Failed, retrying**. Hover over **Copied** for where and when. **Waiting** means the service has not reached it yet; it copies newest first, one at a time. **Failed, retrying** has the store's reason in the tooltip.
- **Copied** stays on a backup after the destination is removed. A backup copied to a destination that was since replaced goes back to **Waiting**, and the service copies it again. **—** means no destination is set and no copy was made.
- A failed copy never fails the backup. The local backup is still good, and the service tries the copy again a few minutes later.
- **Pruning applies to the copies too.** When the retention window prunes a backup, the service deletes its copy from the bucket as well. Pinned backups and the newest three are kept in both places.
- **Keep the bucket credentials and the identity somewhere else.** The secret key is stored in the Vault, and the Vault is inside every backup. A restore after losing the site starts from the bucket, without the Vault.

The Grafana alert **Off-site Backup Stale** fires when the newest backup has had no copy for 12 hours.

## What this page does not do

There is no download. A backup holds every user account, every service credential's hash, the whole audit trail and the historian's password. So the files stay on the backup volume and, encrypted, in the off-site bucket. Restoring from either is done from a shell, following the runbook. A run's panel shows where its files are inside the service's container.

## Who can use it

Administrator only. Nobody else sees this page, reads these tables, or can ask for a backup.
