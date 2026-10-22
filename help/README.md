# Help

These pages are for the people who install Aber and use it. Start with the install guide. Then
build your first machine with the tutorial. In the dashboard, the **?** button in the top bar opens
the help for the page you are on.

Everything here is written for someone new to Aber. Pages for people who change Aber's code are in
[`docs/`](../docs/README.md), and beside the code they describe.

## Site

- [Installing Aber](site/install.md): put the server on a Linux machine, sign in, and add your
  first gateway.
- [Remote gateways](site/remote-gateways.md): set up a gateway on its own hardware, keep it
  running, and fix it when something goes wrong.
- [Upgrading Aber](site/upgrading.md): move to a new release with one command, and what needs your
  attention when you do.
- [Bringing your own edge node](site/bring-your-own-edge-node.md): what an edge node you chose must do to send data to Aber.

## Guides

- [Build your first machine](guides/tutorial.md): connect one machine to Aber and watch its
  readings arrive.
- [Glossary](guides/glossary.md): the words Aber uses, in plain terms.

## Pages

The help for each page of the dashboard, in the order the sidebar lists them.

- [Site Map](pages/site-map.md): the front page, with each area drawn as its plan.
- [Approvals](pages/approvals.md): changes that wait for someone to approve them.
- [Areas](pages/areas.md): the parts of your site, such as a hall or a yard.
- [Cells](pages/cells.md): the lines and bays where gateways and devices are put.
- [Gateways](pages/gateways.md): the computers that send your machines' data to Aber.
- [Devices](pages/devices.md): the machines, or parts of machines, that gateways send data for.
- [Schemas](pages/schemas.md): what a kind of device is expected to send.
- [Metrics](pages/metrics.md): the catalog of values that schemas are built from.
- [Vocabulary](pages/vocabulary.md): the terms that industrial standards define.
- [Audit Trail](pages/audit-trail.md): what changed, who changed it, and when.
- [Capture](pages/capture.md): record what the broker carried, and play it back.
- [Cold Storage](pages/cold-storage.md): old readings, moved out of the live database.
- [Backups](pages/backups.md): take a backup, and see every backup run.
- [Archived Entities](pages/archives.md): bring back, or delete, what was taken out of service.
- [Directory](pages/directory.md): every service Aber runs, and how to reach it.
- [Access Control](pages/access-control.md): who and what may reach Aber.
- [Settings](pages/settings.md): the settings for the whole site.
- [Profile](pages/profile.md): your account, and how the dashboard looks to you.

## Writing a page

Everything in this folder is for newcomers, so it follows the rules in
[Writing documentation](../CONTRIBUTING.md#writing-documentation). A page for a dashboard page goes
in `pages/`, named by the page's id.
