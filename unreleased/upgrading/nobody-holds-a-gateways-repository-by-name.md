### From 1.9.1, nobody holds a gateway's repository by name

Enrolment makes a gateway's repository. A person can also make it in the forge first, for example with
**Use this template** for a custom gateway. The forge made that person its administrator, and nothing
took that away. So a Shopfloor Manager who had made one could merge past the Administrator's approval on
`main`, or change the rule that asks for it. A person whose role had been removed still could, with a
token of their own. They could also move the repository's default branch, which enrolment told the
appliance to follow. The advisory is
[GHSA-84xw-m29x-9r4r](https://github.com/Harri-Llewelyn/Aber/security/advisories/GHSA-84xw-m29x-9r4r),
as for [the tags](a-tag-cannot-stand-in-for-a-gateways-branch.md).

A gateway whose repository enrolment made was not affected, unless an operator gave somebody the
repository by name.

#### What changes by itself

Within fifteen minutes of the upgrade, the forge's sweep does this in the repository of each gateway in
service, and the first of it in an archived gateway's. Enrolment does the same, before the gateway's key
is registered.

- **It removes everybody who holds the repository by name**, a person you added yourself included. What
  a person may do comes from their role.
- **It puts back what makes the approval real**, where the rule on `main` is looser:
  - no push, and no bypass list;
  - no file left unprotected;
  - at least one approval, from the `administrators` team and from nobody else;
  - an approval dismissed when the proposal changes.

  A looser setting of your own is put back too. A tighter one stays: more approvals, other required
  checks, protected files, a list of who may merge.
- **It dismisses the approvals on open proposals** where the rule asked for less than that. Approve them
  again.
- **It removes any other branch rule.** One on a single other branch, which asks what `main`'s asks,
  stays.
- **It makes `main` the default branch again.** The branch it was asks for the approval too, from then on.
- **It removes a deploy key that is not the gateway's own**, and a gateway's key from any other repository.
- **It gives a renamed repository its name back**, and turns proposals on where they were off.

The forge no longer fetches from another host or pushes to one. A migration, a pull mirror and a push mirror
are refused, in every repository of the forge, one that already stands included.

#### What you do

Nothing, unless you gave somebody a gateway's repository by name. Give that person a role on
**Access Control** instead.

#### What to look at

The log names each repository where one of these was needed:

```bash
kubectl -n aber logs deploy/supabase-functions --since=24h \
  | grep -E 'was held by|put back|admitted pushes|removed the branch rule|the default branch of|dismissed an approval|and is again|took no proposals|deploy keys are removed'
```

No line means that every repository was as enrolment makes it. For each repository named:

1. Read its commits on `main` in the forge. A change merged past the approval is still there, and where
   somebody held the repository it need not have left a looser rule. To undo one, revert it by pull
   request. If you do not know it and it changed `custom.yml` or `platform.yml`, rebuild the machine: the
   appliance ran that as root.
2. If the line says it was renamed (*was … and is again*), set the gateway up again, so that its appliance
   has the repository's own address.
3. If the line says its deploy keys are removed, it is a mirror, or it has a branch rule that cannot be
   removed. The appliance goes on running what it has. Remove the rule as
   [`supabase/README.md`](../../supabase/README.md#the-appliance-reports-on-a-branch-of-its-own-archived-migration-0104)
   says, or keep a clone of the repository and delete it. A new name is not enough: it would have its name
   back. Then set the gateway up again.
4. If the line says the default branch was another one, the appliance may have enrolled on it. Put what it
   should run on `main`, and set the gateway up again. Until then, an appliance on this release's platform
   says *REFUSING TO SYNC* and goes on running what it has. One on an earlier platform follows that
   branch, which now needs the approval.

#### What an approval does not cover

A repository made by hand arrives as its maker left it. **What `main` holds when the gateway enrols is
deployed as it is**, and nobody approved it. Read it before you set the appliance up.
