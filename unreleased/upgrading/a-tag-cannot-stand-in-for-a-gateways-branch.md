### From 1.9.1, a tag cannot stand in for a gateway's branch

An appliance deploys what its repository's `main` holds. It fetched `main` by its short name, and Git
takes a short name for a tag before a branch. So a tag named `main` decided what the appliance
deployed: its flow, and the repository's own `custom.yml`, which runs as root. No approval stood in the
way. The gateway's own key could make such a tag, and so could anybody who can write the repository,
which a Shopfloor Manager can on every gateway. The advisory is
[GHSA-84xw-m29x-9r4r](https://github.com/Harri-Llewelyn/Aber/security/advisories/GHSA-84xw-m29x-9r4r),
which also covers [who holds a gateway's repository](nobody-holds-a-gateways-repository-by-name.md).

It is closed at both ends. The forge's end needs nothing from you. The appliance's needs one pull
request for each Remote gateway.

#### What changes by itself

Within fifteen minutes of the upgrade, the forge's sweep does this in each gateway's repository:

- **It adds two rules for tags.** Nobody can make a tag named `main` or `appliance`, in any case. A
  gateway's key can make no tag at all. Administrators and Shopfloor Managers make every other tag, and
  releases, as before.
- **It removes a tag rule of your own**, if you added one in the forge's settings. The forge admits
  whoever any rule admits, so a second rule could only let more people in.
- **It deletes a tag named `main` or `appliance`** that is already there, and the release made from it.

A new gateway gets the rules when it enrols, before its key is registered.

#### What you do for each Remote gateway

Move the gateway to this release's platform. Until you do, the forge's rules protect it, and the
appliance still reads a short name.

1. In the forge, change `tag` in the gateway's `platform.yml` to `v1.9.1` by pull request.
2. Another Administrator approves it, because the forge does not let an author approve their own. On a
   site with one Administrator, add a second on **Access Control** with **Add Person**. Approve as
   them in a private window, merge, then choose **Remove Access**.
3. The appliance converges within the hour. The drawer's **Platform** row then shows `v1.9.1`.

#### What to look at

See whether the sweep deleted a tag. The log names the repository and the commit:

```bash
kubectl -n aber logs deploy/supabase-functions --since=24h | grep 'carries a tag named'
```

No line means that no repository had one. Aber makes no such tag, so for each line:

1. Open the commit in the forge, at `<the forge>/gateways/<the repository>/commit/<the commit>`. It
   opens there although the tag is gone.
2. Compare what the appliance runs with `main`. In the gateway's drawer, use **Running vs approved**,
   and read the **Flow** row.
3. If the appliance followed the tag, its log says that the branch *no longer contains* the commit. It
   then fetches nothing more, `v1.9.1` included, and still runs the commit's own `custom.yml` every
   hour. [Remote gateways, *Troubleshooting*](../../help/site/remote-gateways.md#troubleshooting) says
   how to decide, and how to start it again from `main`. If you do not know the commit and it changed
   `custom.yml` or `platform.yml`, rebuild the machine: the appliance ran that as root.

If the log says a tag *could not be removed*, the sweep tries again every fifteen minutes. A tag on a
file or a folder is the one the forge's API cannot delete. Delete it on the forge's volume, with the
repository's name in place of `<repository>` and the tag's name at the end:

```bash
kubectl -n aber exec deploy/gitea -c gitea -- su-exec git \
  git -C /data/git/repositories/gateways/<repository>.git tag -d main
```

#### The forge's and Studio's doors resolve `..` in an address

Their admission step was asked about the address as it was sent, so `/../<function>` asked another
edge function whether the request was admitted. A person whose role had been removed, with a session
still open, was let through to a page that is not there. Nothing was found that it exposes. Both doors
now resolve the address first, and no page's address changes.
