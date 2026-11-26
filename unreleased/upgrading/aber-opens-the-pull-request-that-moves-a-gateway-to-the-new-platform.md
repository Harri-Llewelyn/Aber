### From 1.10.0, Aber opens the pull request that moves a gateway to the new platform

Until 1.10.0, somebody on your site changed the `tag` in a gateway's `platform.yml` after an upgrade,
by a pull request of their own. A site with one Administrator could not merge it: a gateway's `main`
needs one Administrator's approval, and the forge never lets an author approve their own.

From 1.10.0 Aber opens it. Nothing needs doing before you upgrade. Within about fifteen minutes
afterwards, the repository of each Remote gateway in service that is on an older release holds one
pull request, *Converge to the platform at* `v1.10.0`, from Aber's own account. It changes that one
line. A site with more than ten such gateways gets ten every fifteen minutes.

1. Start with one gateway. Open its drawer, and its **Health** block. The **Platform** row says
   *v1.10.0 waits for approval*, which is a link to the pull request. A gateway that has reported no
   health has no such row: choose **Open in the forge** in its drawer, then **Pull Requests**.
2. As an Administrator, read the change and approve it. Nobody on your site wrote it, so you may.
3. Merge it. The appliance converges within the hour, and the drawer's **Platform** row shows the new
   release. Then do the others: **Release waiting** on the Gateways page lists them.

Nothing moves until you merge, so a gateway you leave alone keeps running as it is.

- **To keep a gateway on its release**, close its pull request. Aber does not open another for that
  release, and opens one for the next. You can reopen it.
- **A tag you chose yourself is left alone**: a branch, a commit, a pre-release, or a newer release. A
  `platform.yml` that Aber cannot change safely is left alone too, and the functions log says why.
- **A pull request of your own still works.** Close Aber's if you move the tag yourself.
- **Coming from 1.9.0 or earlier,** merge Aber's pull request in place of the one
  [*a tag cannot stand in for a gateway's branch*](../../help/site/upgrading.md#from-191-a-tag-cannot-stand-in-for-a-gateways-branch)
  asks you to make. The platform at `v1.10.0` carries 1.9.1's fix, and needs no second Administrator.
- **An appliance whose `flow-sync` never started**, on a tag before `v1.9.0`, cannot fetch the merge.
  Merge Aber's pull request, then do step 2 of
  [*flow sync starts on an appliance the install command set up*](../../help/site/upgrading.md#from-190-flow-sync-starts-on-an-appliance-the-install-command-set-up)
  once, with the tag the pull request names in place of `v1.9.0`.

Every gateway repository also gets a fourth branch rule, `aber-platform-*`. It gives those branches to
Aber's account and closes them to everyone else, and to the appliance's key. The page on
[remote gateways](../../help/site/remote-gateways.md#who-may-approve-and-the-change-aber-proposes) has
the rest.
