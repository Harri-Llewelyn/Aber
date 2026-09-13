## Summary

Take a backup of the whole platform without a shell, and see which backups exist. A backup is both databases, the 3D model objects and the forge, written by the backup service onto its own volume. Nothing on this page produces a backup itself: **Take a backup** queues a request and the service does the work, so the row shows up as queued, then running, then either a stored backup or a failure with its reason.

## What the controls do

- **Take a backup** queues one now. The note is kept with the backup and is the thing to read when choosing which one to restore from, so say why it was taken.
- **Cancel** withdraws a request the service has not yet claimed. A running backup cannot be cancelled; it finishes or fails.
- **Release** lets the retention window apply to a backup that was taken on request. Nothing is deleted at that moment: the service prunes it on its next pass, and only once it is older than the window.

## What the states mean

A **queued** backup that stays queued means no backup service is running: the `backup-service` Deployment is down. Cancel it or start the service; one backup runs at a time, so a queued one blocks the next.

A backup taken **on request** is **pinned**: the retention window does not apply to it until it is released. A backup taken **on the schedule** is pruned once it is older than the window. Both kinds are listed until the service removes their files.

Failed backups leave no files behind. The reason the service gave is on the row.

## What this page does not do

There is no download. A dump holds every user account, every service credential's hash, the whole audit trail and the historian's password; the files stay on the backup volume, and restoring from one is a runbook run from a shell against that volume. The location column says where the files are inside the service's container.

## Who can use it

Administrator only. Nobody else sees this page, reads these tables, or can ask for a backup.
