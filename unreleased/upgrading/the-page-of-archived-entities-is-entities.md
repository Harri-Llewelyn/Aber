### From 1.10.0, the page of archived entities is Entities

The dashboard page that listed archived and retired entities is now **Entities**. It has a new first tab,
**Active**, which lists everything in service. One search on the page finds what any ID names
([the page's help](../../help/pages/archives.md)).

**Nothing needs doing.** What you may notice:

- **Every role now has the page in the sidebar.** It was for Administrators and Shopfloor Managers. Each
  role sees only what it could already see on the other pages. Nobody gains **Restore**, **Export Bundle…**
  or **Permanent Delete**: those are still for Administrators and Shopfloor Managers.
- **Every role can open the Archived tab.** It lists archived areas, cells, gateways and devices, which every
  role could already read with each page's lifecycle filter. The **Retired** tab is still for Administrators,
  Shopfloor Managers and Auditors.
- **Old links still work.** `/archives` opens the Archived tab, and `/archives/retired` the Retired one.
- **Written instructions of your own** that send people to the page by its old name need the new one. So do
  alerts or scripts that match the old name in a log line: ingestion's line for traffic from an archived
  device now says *Restore it on the Entities page*.
- **The API has two new reads:** the view `entity_directory` and the function `find_entities()`. Both run as
  their caller.
