import React from 'react'
import { PERMISSION_UUIDS } from './constants'
import { STANDARDS } from './utils/standards'
import { pathSegments, pathSlug } from './hooks/useUrlState'
import {
  IconMap,
  IconLayoutDashboard,
  IconFactory,
  IconRadio,
  IconCpu,
  IconArchive,
  IconClipboardList,
  IconFileCode,
  IconHistory,
  IconRecord,
  IconDatabase,
  IconHardDrive,
  IconServer,
  IconLock,
  IconSettings,
  IconInbox,
  IconTag,
  IconUser
} from './components/common/Icons'

/*
 * The navigation model, read by the sidebar, the search palette and App.jsx. It lives here
 * rather than in App.jsx because a component App renders cannot import App without a cycle.
 */

/*
 * Each page's tabs, in order. The id is the tab's path segment (`/devices/quarantine`) and the first
 * tab is the bare page; `description` is the tooltip on the page's tab bar (TabStrip). The sidebar
 * lists them under their page, the page draws its tab bar from them, and the search's tab cards
 * take their names from them. A page imports its list from here, never the reverse: App.jsx loads
 * the pages lazily, and the sidebar must not pull them into the first bundle.
 */
export const DEVICES_TABS = [
  { id: 'registered', label: 'Registered', description: 'Devices admitted to Aber. Their status says when one publishes what its schema does not include, or nothing yet.' },
  { id: 'quarantine', label: 'Quarantine', description: 'Births from devices nobody has registered. Their readings are held until someone approves or rejects them.' },
]

export const APPROVALS_TABS = [
  { id: 'open', label: 'Awaiting a decision', description: 'Proposed changes nobody has decided yet, oldest first. Approving one makes the change.' },
  { id: 'decided', label: 'Decided', description: 'Proposals applied, rejected, withdrawn or expired, newest decision first. Each is kept for a period an Administrator sets.' },
]

export const METRICS_TABS = [
  { id: 'catalog', label: 'Metric Catalog', description: "The metrics schema authors build from, grouped by their name's first segment. A name cannot change once created." },
  { id: 'deprecated', label: 'Deprecated Metrics', description: 'Metrics withheld from the schema builder, and what replaced each. Schemas that model one keep it, with its readings.' },
  { id: 'uncatalogued', label: 'Uncatalogued', description: 'Metric names devices declare that no catalog row describes. Their readings are stored, but carry no unit or meaning.' },
]

/** The standards in the page's order; each tab's tooltip is its standard's own hint (VocabularyPanel). */
export const VOCABULARY_TABS = [STANDARDS.MTCONNECT, STANDARDS.ISO22400, STANDARDS.OPCUA, STANDARDS.ASHRAE223]
  .map(label => ({ id: pathSlug(label), label }))

export const CAPTURE_TABS = [
  { id: 'gateway', label: 'Gateways', description: 'Record everything one gateway publishes, every device beneath it included.' },
  { id: 'device', label: 'Devices', description: "Record one device, plus its gateway's birth certificate." },
]

export const ARCHIVES_TABS = [
  { id: 'archived', label: 'Archived', description: 'Out of commission but kept, with its history and identifiers. Restore returns one intact, until its auto-purge date.' },
  { id: 'retired', label: 'Retired', description: 'Archived and then deleted. Only a tombstone remains, linking to what survives: the Audit Trail, a forge repository, a bundle.' },
]

/**
 * The service groups. The page draws a group's tab only while it has rows, and adds a tab for any
 * service type no group claims, so these three are the ones a link can count on.
 */
export const SYSTEM_TABS = [
  { id: 'applications', label: 'Applications & User Interfaces', description: 'The things with a front door: each link opens something the dashboard does not do itself.' },
  { id: 'ingestion', label: 'Ingestion & Messaging', description: 'The path a reading takes from a machine to the historian. If telemetry stops, look here first.' },
  { id: 'infrastructure', label: 'Data & Backend Infrastructure', description: 'What the services on the other tabs are built on: the databases, APIs and sign-in behind them.' },
]

/** People leads, and is offered to an Administrator only, as the page itself is. */
export const ACCESS_CONTROL_PEOPLE_TAB = {
  id: 'people',
  label: 'People',
  description: 'Everyone who signs in to the dashboard, with their role. Add people, change roles, or remove access here.',
}

/** Administrator only too, beside People: the apps that sign those people in. */
export const ACCESS_CONTROL_APPS_TAB = {
  id: 'apps',
  label: 'Apps',
  description: 'The apps that sign people in with Aber, such as Grafana, and who has allowed each one.',
}

export const ACCESS_CONTROL_TABS = [
  { id: 'credentials', label: 'Broker credentials', description: "Every gateway's broker credential: what Aber issued and recorded, beside what the broker holds now." },
  { id: 'identities', label: 'Machine identities', description: "Aber's own processes on the database side. None can sign in: each holds a token and permissions of its own." },
  { id: 'accounts', label: 'Broker accounts', description: "The broker's own accounts, read live, including any that look like a gateway's but that no gateway claims." },
  { id: 'roles', label: 'Broker roles', description: 'What each broker role may publish, receive and subscribe to, read live. Open a role to read its rules.' },
]

/**
 * The Settings categories. The page's tabs are the categories the database returns, in its order
 * (by name); this is the copy the sidebar lists before the page has read them, and each category's
 * tooltip, since the database holds no description for one. A category missing here still shows on
 * the page, with no tooltip. The id is `pathSlug(label)`.
 */
export const SETTINGS_TABS = [
  { id: 'approvals', label: 'Approvals', description: 'How many proposals one person may hold open, when an open one expires, and how long decided ones are kept.' },
  { id: 'audit-trail', label: 'Audit Trail', description: 'How often the Audit Trail page reads the audit log again while it is open.' },
  { id: 'cold-storage', label: 'Cold Storage', description: "When readings move out to the cold archive, and the key that names this site's archive." },
  { id: 'retention', label: 'Retention', description: 'How long Aber keeps records, such as resolved alerts, before the nightly prune removes them.' },
  { id: 'site', label: 'Site', description: "The site's name, the Sparkplug group its gateways publish under, and how close cells may sit on a plan." },
]

/** The ids are the page's anchors: the search bar opens one by id. */
export const PROFILE_TABS = [
  { id: 'account', label: 'Account', description: 'The address you sign in with, your role, and your password.' },
  { id: 'appearance', label: 'Appearance', description: 'How the dashboard looks and behaves for you: theme, sidebar layout and single-key shortcuts.' },
  { id: 'security', label: 'Security', description: 'Where you are signed in, your second factor, and the apps you have allowed.' },
]

/*
 * The groups. Each answers one question and the questions do not overlap:
 *
 *   Work           -- what is waiting for me? Approvals.
 *   Assets         -- what is out there? The physical estate.
 *   Modelling      -- what does it mean? Read down: the contract, the catalogue it is built from,
 *                     the standards the catalogue draws on. Most-worked to most-reference.
 *   History        -- what happened? Both pages are a record of the past.
 *   Retention      -- what is kept, and how is it got back? Every page here runs a retention
 *                     timer over something and offers a way to restore from it.
 *   Administration -- who may do what, what runs, how is it configured?
 *
 * The Site Map is the landing page, alone in `home`. Audit Trail leads History rather than
 * sitting beside Devices because it is the audit trace of every entity.
 *
 * The groups are not captioned in the rail: the separator is the whole of the grouping, and a
 * caption had to hold its box in the collapsed state to stop items jumping on hover.
 */
export const NAV_GROUPS = [
  { id: 'home' },
  // A work queue: it answers "what is waiting for me", which none of the subject groups asks, and
  // its rows are proposals against every kind of entity. Not in `admin`, because Approvals is the
  // one page an Operator has something to do on.
  { id: 'work' },
  { id: 'assets' },
  { id: 'model' },
  { id: 'history' },
  { id: 'retention' },
  { id: 'admin' }
]

/*
 * The pages. `pageTabs` is a page's tabs, from the lists above. `signalTab` is the tab the rail's
 * signal for the page is about (hooks/useNavSignals.js): while the sidebar lists the page's tabs,
 * the count shows on that tab instead of on the page.
 */
export const TABS = [
  { id: 'site-map',       label: 'Site Map',       group: 'home',    icon: <IconMap size={16} /> },
  // Gated on `proposal:create`: an Auditor holds neither it nor a decision gate, and RLS would
  // return them their own proposals, of which they can have none.
  { id: 'approvals',      label: 'Approvals',      group: 'work',    icon: <IconInbox size={16} />, permission: PERMISSION_UUIDS.PROPOSAL_CREATE, pageTabs: APPROVALS_TABS, signalTab: 'open' },

  // The ISA-95 order, top down: an area holds cells, a cell holds gateways and devices. The
  // glyphs read the same way: the map is the site, the factory an area, the grid its cells. The
  // chips and section icons on the other pages use the same three.
  { id: 'areas',          label: 'Areas',          group: 'assets',  icon: <IconFactory size={16} /> },
  { id: 'cells',          label: 'Cells',          group: 'assets',  icon: <IconLayoutDashboard size={16} /> },
  { id: 'gateways',       label: 'Gateways',       group: 'assets',  icon: <IconRadio size={16} /> },
  { id: 'devices',        label: 'Devices',        group: 'assets',  icon: <IconCpu size={16} />, pageTabs: DEVICES_TABS, signalTab: 'quarantine' },

  { id: 'schemas',        label: 'Schemas',        group: 'model',   icon: <IconClipboardList size={16} /> },
  // IconTag, not IconGauge (which already means a metrology cell) and not IconActivity (which
  // means live telemetry): this page is the definitions, never the readings.
  { id: 'metrics',        label: 'Metrics',        group: 'model',   icon: <IconTag size={16} />, pageTabs: METRICS_TABS },
  // Reference you read, where the two above are state you edit.
  { id: 'vocabulary',     label: 'Vocabulary',     group: 'model',   icon: <IconFileCode size={16} />, pageTabs: VOCABULARY_TABS },

  /* Gated on the permission, not on role names: the `audit_trail` SELECT policies resolve
     `audit_trail:read`, so one predicate decides visibility and access. Without it an Operator
     saw an empty table with no explanation, since RLS returns no rows rather than an error. */
  { id: 'audit-trail', label: 'Audit Trail', group: 'history', icon: <IconHistory size={16} />, permission: PERMISSION_UUIDS.AUDIT_TRAIL_READ },
  // The three roles the database admits: SELECT on `captures` and `capture_jobs` is granted to
  // Administrator, Shopfloor_Manager and Auditor. Operator is absent, which is why the page is
  // gated at all.
  { id: 'capture',        label: 'Capture',        group: 'history', icon: <IconRecord size={16} />, role: ['Administrator', 'Shopfloor_Manager', 'Auditor'], pageTabs: CAPTURE_TABS },

  // THE SAME THREE ROLES `cold_storage_rows()` RETURNS ROWS TO, and the function checks them in its
  // own body rather than relying on this: the catalogue names object keys, and the bucket policy
  // admits exactly these three to read what those keys point at.
  { id: 'cold-storage',   label: 'Cold Storage',   group: 'retention', icon: <IconDatabase size={16} />, role: ['Administrator', 'Shopfloor_Manager', 'Auditor'] },
  // Administrator alone, as request_backup() and the two tables' SELECT policies are: a backup
  // is an act on the whole database, and reading what exists sizes the security lane.
  { id: 'backups',        label: 'Backups',        group: 'retention', icon: <IconHardDrive size={16} />, role: 'Administrator' },
  /* "Archived Entities", not "Archives": it sits next to Cold Storage, and the label tells them
     apart. This page lists areas, cells, gateways and devices taken out of commission; that one is
     telemetry tiered to Parquet. Filed here rather than with the assets because each page in this
     group runs a retention timer over something and offers a way back from it. */
  { id: 'archives',       label: 'Archived Entities', group: 'retention', icon: <IconArchive size={16} />, permission: PERMISSION_UUIDS.ARCHIVE_MANAGE, pageTabs: ARCHIVES_TABS },

  // What runs, who may touch it, and how it is tuned. System and Settings are ungated and Access
  // Control is Administrator-only, so for anyone else this group is the two. IconServer, not
  // IconActivity, which means live telemetry.
  { id: 'system',         label: 'System',         group: 'admin',   icon: <IconServer size={16} />, pageTabs: SYSTEM_TABS },
  // Access Control is narrower than the API behind it: seeing who holds what is an access-control
  // question, and a Shopfloor_Manager who needs to issue a credential still can, from Gateways.
  { id: 'access-control', label: 'Access Control', group: 'admin',   icon: <IconLock size={16} />, role: 'Administrator', pageTabs: [ACCESS_CONTROL_PEOPLE_TAB, ACCESS_CONTROL_APPS_TAB, ...ACCESS_CONTROL_TABS] },
  // Ungated, because every signed-in account may read a setting (rows marked `sensitive` reach
  // Administrators only); changing one is the database's Administrator gate, and the page is
  // read-only for any other role.
  { id: 'settings',       label: 'Settings',       group: 'admin',   icon: <IconSettings size={16} />, pageTabs: SETTINGS_TABS },
  // No group, so the rail does not draw it: the account menu at the rail's foot is its way in.
  { id: 'profile',        label: 'Profile',        icon: <IconUser size={16} />, pageTabs: PROFILE_TABS }
]

/**
 * Whether a page appears in the navigation. Only a courtesy: hiding a page removes a signpost,
 * not an ability, and what refuses a request is the RLS policy.
 */
export function tabIsVisible(tabDef, hasPermission, userRole) {
  // `role` takes a list as well as a string: the Capture page is admitted to three roles, and a
  // single-role gate would hide it from two the database admits.
  if (tabDef.role) {
    const allowed = Array.isArray(tabDef.role) ? tabDef.role : [tabDef.role]
    if (!allowed.includes(userRole)) return false
  }
  if (!tabDef.permission) return true
  return hasPermission(tabDef.permission)
}

/**
 * The visible pages, bucketed into the groups above, with empty groups dropped: a separator with
 * nothing under it reads as a page that failed to load. A page with no group is left out.
 */
export function groupedNav(visibleTabs) {
  return NAV_GROUPS
    .map(group => ({ ...group, tabs: visibleTabs.filter(t => t.group === group.id) }))
    .filter(group => group.tabs.length > 0)
}

/** A page's tabs, or an empty list for a page without them. */
export const pageTabsOf = (pageId) => TABS.find(t => t.id === pageId)?.pageTabs || []

/** A tab's address, as useUrlTab writes it: the bare page for the first tab. */
export function tabHref(pageId, tabId) {
  const first = pageTabsOf(pageId)[0]
  return !tabId || tabId === first?.id ? `/${pageId}` : `/${pageId}/${tabId}`
}

/**
 * The tab `url` shows on `pageId`: the one its second path segment names, else the first, as the
 * page reads it. Null for a page without tabs.
 */
export function currentTabOf(pageId, url) {
  const tabs = pageTabsOf(pageId)
  if (tabs.length === 0) return null
  const [page, segment] = pathSegments(url)
  return (page === pageId && tabs.find(t => t.id === segment)) || tabs[0]
}

/** The page's name with its tab's, "Devices › Quarantine", for the browser tab's title. */
export function pageTitleOf(pageId, url) {
  const page = TABS.find(t => t.id === pageId)
  if (!page) return undefined
  const tab = currentTabOf(pageId, url)
  return tab ? `${page.label} › ${tab.label}` : page.label
}
