## Summary

Take a backup of the whole platform without a shell, and see every backup run: what it stored, or why it failed. A backup is both databases, the key their Vault secrets are encrypted under, the stored files (3D models, area plans, broker captures and export bundles), the forge, the broker's accounts and, where the platform issues its own certificates, the internal CA, written by the backup service onto its own volume. Nothing on this page produces a backup itself: **Take a backup** queues a request and the service does the work, so it shows as queued, then running, then as a run in the list that either completed or failed.

**The historian in a backup holds raw telemetry for the raw window (14 days unless the site changed it) and the 1-minute, 5-minute and 1-hour rollups.** Raw readings older than the window are only on cold storage, which no backup includes.

**Where the historian has its own physical backup, it is not in these.** The components then list no historian, and the historian is backed up daily by the database itself, with every change archived in between, so it can be restored to any moment rather than to the last backup. A night it missed while the platform was off is taken when the historian is back. Restoring it is a runbook run from a shell.

## What the controls do

- **Take a backup** queues one now. The note is kept with the backup and is the thing to read when choosing which one to restore from, so say why it was taken.
- **Cancel** withdraws a request the service has not yet claimed. A running backup cannot be cancelled; it finishes or fails.
- **Release** lets the retention window apply to a backup that was taken on request. Nothing is deleted at that moment: the service prunes it on its next pass, and only once it is older than the window and not one of the newest three.
- **Set a destination** (**Complete the destination** while a field is missing, **Change destination** once one is set), beside **Take a backup**, opens the off-site destination: the S3 endpoint, region, bucket, key prefix, access key ID and secret key, and the age public key every file is encrypted to. **Address the bucket by path** is for MinIO and most self-hosted stores; leave it off for AWS, R2 and B2. **Remove the destination** stops the copies and deletes the secret key; copies already made stay in the bucket.
- **The filter** shows every run, or only the completed or only the failed ones. A cancelled run is listed under all runs only. The list shows the newest 30 runs under the filter. The foot says how many are loaded, such as `30 of 57`, beside **Show 27 more**, which adds older ones up to 30 at a time; it says **All 57 shown.** at the end.
- **A run** opens its panel when you select it anywhere on its row, or press Enter or Space on it: the whole of any failure, when it was queued, started and finished, and for a backup where its files are, each file with its size, and its off-site copy. **Release** is there too, on a pinned backup.

## Whether backups are working now

One line above the list answers this, and appears only when the answer is no:

- **The last backup failed**, and none has succeeded since. It names when the last good backup was taken. A failure followed by a success is history: it stays in the list and the line goes.
- **No backup has succeeded in 36 hours**, so the nightly schedule has missed a night. This is also what a stopped backup service looks like: a service that is not running records no failure. Before the first success, the hours count from the first backup queued.

Either line clears itself on the next successful backup. On a stack where the backup service has never run, there is nothing to report, and the page says no backups exist yet. The Grafana alert **Backup Stale** fires on the same 36 hours, so the condition reaches the alert counter in the top bar without anyone opening this page.

**A scheduled backup missed while the platform was off is taken late, once.** When no scheduled backup was queued in the last 25 hours, the service queues one as soon as it is running, so a stack switched off overnight takes its backup when it is next up. It is listed as **Scheduled**, at the time it was taken. A late backup that fails is not tried again before the next night; the line above reports it.

## What the list shows

Every run the service has finished, newest first. Runs are never deleted, so the list is the history.

- A **completed** run shows its backup: when it was taken, the stamp its files carry, its **Origin** (on request or scheduled), its size, what it holds and its retention. **Holds** names each component: the platform database, the historian, the Vault root key, the stored files, the forge, the broker accounts and the internal CA. Its panel lists each file and its size. Once the retention window has pruned it, the run stays and says **Pruned by the retention window** under its status; its files are gone.
- A **failed** run shows the reason the service gave under its status, cut to one line; its panel has the whole of it. A failed backup leaves no files behind.
- A **cancelled** run was withdrawn before the service claimed it, and says so under its status.
- A run with no backup shows a dash in **Size**, **Holds**, **Retention** and **Off site**.

A **queued** backup that stays queued means no backup service is running: the `backup-service` Deployment is down. Cancel it or start the service; one backup runs at a time, so a queued one blocks the next.

A backup taken **on request** is **pinned**: the retention window does not apply to it until it is released. A backup taken **on the schedule** is pruned once it is older than the window, **except that the newest three backups are always kept**, whatever their age. While backups are failing those three are the last good ones, so a run of failures longer than the window cannot prune them. The **Retention** column says **Pinned** on a requested backup, **Kept: one of the newest three** on a backup the window has passed and the floor is keeping, **Kept: pruning is off** when the site set the retention window to 0 days, and **Released** with the date once a pinned backup was released.

## The off-site copy

The backup volume is usually on the same disk as both databases, so on its own it survives a dropped table and not a lost disk, node or site. With a destination set, the backup service copies every backup to the S3 bucket, and keeps the local one. Each file is encrypted with age before it leaves the service, to the public key you entered, so neither the bucket's credential nor the service can read a copy. Only the matching identity (the private key) decrypts it.

- **The destination button** in the header says whether copies are made. While there is no off-site copy it reads **Set a destination**, and while the destination is missing a field it reads **Complete the destination**; both are amber with a warning icon and say what is missing. Once copies can be made it reads **Change destination**, and its tooltip names where they go.
- **The Off site column** says, for each backup, **Copied** (hover for where and when), **Waiting** for the service to reach it (newest first, one at a time), or **Failed, retrying** with the store's reason in the tooltip. **Copied** stays on a backup after the destination is removed. A backup copied to a destination since replaced goes back to **Waiting**, and the service copies it again. **—** means no destination is set and no copy was made. A failed copy never fails the backup: the local one is good, and the service tries the copy again a few minutes later.
- **Pruning applies to the copies too.** When the retention window prunes a backup, the service deletes its copy from the bucket as well; pinned backups and the newest three are kept in both places.
- **Keep the bucket credentials and the identity somewhere else.** The secret key is stored in the Vault, and the Vault is inside every backup, so a restore after losing the site starts from the bucket without it.

The Grafana alert **Off-site Backup Stale** fires when the newest backup has had no copy for 12 hours.

## What this page does not do

There is no download. A dump holds every user account, every service credential's hash, the whole audit trail and the historian's password; the files stay on the backup volume and, encrypted, in the off-site bucket, and restoring from either is a runbook run from a shell. A run's panel shows where its files are inside the service's container.

## Who can use it

Administrator only. Nobody else sees this page, reads these tables, or can ask for a backup.
