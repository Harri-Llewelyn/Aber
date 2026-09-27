## Summary

Take a backup of the whole platform without a shell, and see every backup run: what it stored, or why it failed. A backup is both databases, the key their Vault secrets are encrypted under, the 3D model objects, the forge, the broker's accounts and, where the platform issues its own certificates, the internal CA, written by the backup service onto its own volume. Nothing on this page produces a backup itself: **Take a backup** queues a request and the service does the work, so it shows as queued, then running, then as a run in the list that either completed or failed.

**The historian in a backup holds raw telemetry for the raw window (14 days unless the site changed it) and the 1-minute, 5-minute and 1-hour rollups.** Raw readings older than the window are only on cold storage, which no backup includes.

## What the controls do

- **Take a backup** queues one now. The note is kept with the backup and is the thing to read when choosing which one to restore from, so say why it was taken.
- **Cancel** withdraws a request the service has not yet claimed. A running backup cannot be cancelled; it finishes or fails.
- **Release** lets the retention window apply to a backup that was taken on request. Nothing is deleted at that moment: the service prunes it on its next pass, and only once it is older than the window.
- **The filter** shows every run, or only the completed or only the failed ones. A cancelled run is listed under all runs only. The list shows the newest 30; **Show more** adds 30 older ones.

## Whether backups are working now

One line above the list answers this, and appears only when the answer is no:

- **The last backup failed**, and none has succeeded since. It names when the last good backup was taken. A failure followed by a success is history: it stays in the list and the line goes.
- **No backup has succeeded in 36 hours**, so the nightly schedule has missed a night. This is also what a stopped backup service looks like: a service that is not running records no failure. Before the first success, the hours count from the first backup queued.

Either line clears itself on the next successful backup. On a stack where the backup service has never run, there is nothing to report, and the page says no backups exist yet. The Grafana alert **Backup Stale** fires on the same 36 hours, so the condition reaches the alert counter in the top bar without anyone opening this page.

## What the list shows

Every run the service has finished, newest first. Runs are never deleted, so the list is the history.

- A **completed** run shows its backup: when it was taken, the stamp its files carry, its size, what it holds and its retention. Once the retention window has pruned it, the run stays and says **Pruned by the retention window**; its files are gone.
- A **failed** run shows the reason the service gave, with the whole of a long one in the tooltip. A failed backup leaves no files behind.
- A **cancelled** run was withdrawn before the service claimed it.

A **queued** backup that stays queued means no backup service is running: the `backup-service` Deployment is down. Cancel it or start the service; one backup runs at a time, so a queued one blocks the next.

A backup taken **on request** is **pinned**: the retention window does not apply to it until it is released. A backup taken **on the schedule** is pruned once it is older than the window.

## What this page does not do

There is no download. A dump holds every user account, every service credential's hash, the whole audit trail and the historian's password; the files stay on the backup volume, and restoring from one is a runbook run from a shell against that volume. Hovering over when a backup was taken shows where its files are inside the service's container.

## Who can use it

Administrator only. Nobody else sees this page, reads these tables, or can ask for a backup.
