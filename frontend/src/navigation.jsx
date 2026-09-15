import React from 'react'
import { PERMISSION_UUIDS } from './constants'
import {
  IconMap,
  IconLayoutDashboard,
  IconFactory,
  IconRadio,
  IconCpu,
  IconArchive,
  IconClipboardList,
  IconFileCode,
  IconBookOpen,
  IconHistory,
  IconRecord,
  IconDatabase,
  IconHardDrive,
  IconLock,
  IconSettings,
  IconInbox,
  IconTag
} from './components/common/Icons'

/*
 * The navigation model, read by the sidebar, the search palette and App.jsx. It lives here
 * rather than in App.jsx because a component App renders cannot import App without a cycle.
 * `TABS` and `tabIsVisible` are re-exported from App.jsx for the tests that import them there.
 */

/*
 * The groups. Each answers one question and the questions do not overlap:
 *
 *   Assets         -- what is out there? The physical estate.
 *   Modelling      -- what does it mean? Read down: the contract, the catalogue it is built from,
 *                     the standards the catalogue draws on. Most-worked to most-reference.
 *   History        -- what happened? Both pages are a record of the past.
 *   Retention      -- what is kept, and how is it got back? Every page here runs a retention
 *                     timer over something and offers a way to restore from it.
 *   Administration -- who may do what, where does everything live, how is it configured?
 *
 * The Site Map is in no group: it is the landing page. Digital Thread leads History rather than
 * sitting beside Devices because it is the audit trace of every entity.
 *
 * The groups are not captioned in the rail: the separator is the whole of the grouping, and a
 * caption had to hold its box in the collapsed state to stop items jumping on hover.
 */
export const NAV_GROUPS = [
  { id: 'home' },
  // A work queue: it answers "what is waiting for me", which none of the subject groups asks, and
  // its rows are devices, nameplates and gateways at once. Not in `admin`, because Approvals is the
  // one page an Operator has something to do on.
  { id: 'work' },
  { id: 'assets' },
  { id: 'model' },
  { id: 'history' },
  { id: 'retention' },
  { id: 'admin' }
]

export const TABS = [
  { id: 'site-map',       label: 'Site Map',       group: 'home',    icon: <IconMap size={16} /> },
  // Gated on `proposal:create`: an Auditor holds neither it nor a decision gate, and RLS would
  // return them their own proposals, of which they can have none.
  { id: 'approvals',      label: 'Approvals',      group: 'work',    icon: <IconInbox size={16} />, permission: PERMISSION_UUIDS.PROPOSAL_CREATE },

  // The ISA-95 order, top down: an area holds cells, a cell holds gateways and devices. The
  // glyphs read the same way: the map is the site, the factory an area, the grid its cells. The
  // chips and section icons on the other pages use the same three.
  { id: 'areas',          label: 'Areas',          group: 'assets',  icon: <IconFactory size={16} /> },
  { id: 'cells',          label: 'Cells',          group: 'assets',  icon: <IconLayoutDashboard size={16} /> },
  { id: 'gateways',       label: 'Gateways',       group: 'assets',  icon: <IconRadio size={16} /> },
  { id: 'devices',        label: 'Devices',        group: 'assets',  icon: <IconCpu size={16} /> },

  { id: 'schemas',        label: 'Schemas',        group: 'model',   icon: <IconClipboardList size={16} /> },
  /* Split out of Schemas, which held the registry and the catalogue in one page. They grow on
     different clocks -- the registry a row per publish, the catalogue a row per metric anyone
     models, for as long as standards keep being adopted -- so each was capping its own height to
     leave the other room and neither had a viewport. Vocabulary left the same page earlier for
     the same reason. */
  // IconTag, not IconGauge (which already means a metrology cell) and not IconActivity (which
  // means live telemetry): this page is the definitions, never the readings.
  { id: 'metrics',        label: 'Metrics',        group: 'model',   icon: <IconTag size={16} /> },
  // Reference you read, where the two above are state you edit.
  { id: 'vocabulary',     label: 'Vocabulary',     group: 'model',   icon: <IconFileCode size={16} /> },

  /* Gated on the permission, not on role names: the `digital_thread` SELECT policies resolve
     `digital_thread:read`, so one predicate decides visibility and access. Without it an Operator
     saw an empty table with no explanation, since RLS returns no rows rather than an error. */
  { id: 'digital-thread', label: 'Digital Thread', group: 'history', icon: <IconHistory size={16} />, permission: PERMISSION_UUIDS.DIGITAL_THREAD_READ },
  // The three roles the database admits: SELECT on `captures` and `capture_jobs` is granted to
  // Administrator, Shopfloor_Manager and Auditor. Operator is absent, which is why the page is
  // gated at all.
  { id: 'capture',        label: 'Capture',        group: 'history', icon: <IconRecord size={16} />, role: ['Administrator', 'Shopfloor_Manager', 'Auditor'] },

  // THE SAME THREE ROLES `cold_storage_rows()` RETURNS ROWS TO, and the function checks them in its
  // own body rather than relying on this: the catalogue names object keys, and the bucket policy
  // admits exactly these three to read what those keys point at.
  { id: 'cold-storage',   label: 'Cold Storage',   group: 'retention', icon: <IconDatabase size={16} />, role: ['Administrator', 'Shopfloor_Manager', 'Auditor'] },
  // Administrator alone, as request_backup() and the two tables' SELECT policies are: a backup
  // is an act on the whole database, and reading what exists sizes the security lane.
  { id: 'backups',        label: 'Backups',        group: 'retention', icon: <IconHardDrive size={16} />, role: 'Administrator' },
  /* "Archived Entities", not "Archives", because it sits next to Cold Storage now and the two
     were only ever told apart by the distance between them: this is cells, gateways and devices
     taken out of commission, that is telemetry tiered to Parquet. The label carries the
     distinction so the rail does not have to.

     Filed here rather than with the assets it archives: the three pages in this group each run a
     retention timer over something and each offer a way back from it, which is one subject rather
     than one permission level -- an Administrator-only group would only ever mean "restricted". */
  { id: 'archives',       label: 'Archived Entities', group: 'retention', icon: <IconArchive size={16} />, permission: PERMISSION_UUIDS.ARCHIVE_MANAGE },

  // Where everything lives, who may touch it, and how it is tuned. Directory is ungated while the
  // other two are Administrator-only, so for anyone else this group is Directory alone.
  { id: 'directory',      label: 'Directory',      group: 'admin',   icon: <IconBookOpen size={16} /> },
  // Gated on the role, because the database gates on the role; a SETTINGS_MANAGE permission for
  // the UI would be a second predicate that can disagree. Access Control is narrower than the API
  // behind it: seeing who holds what is an access-control question, and a Shopfloor_Manager who
  // needs to issue a credential still can, from Gateways.
  { id: 'access-control', label: 'Access Control', group: 'admin',   icon: <IconLock size={16} />, role: 'Administrator' },
  { id: 'settings',       label: 'Settings',       group: 'admin',   icon: <IconSettings size={16} />, role: 'Administrator' }
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
 * nothing under it reads as a page that failed to load.
 */
export function groupedNav(visibleTabs) {
  return NAV_GROUPS
    .map(group => ({ ...group, tabs: visibleTabs.filter(t => t.group === group.id) }))
    .filter(group => group.tabs.length > 0)
}
