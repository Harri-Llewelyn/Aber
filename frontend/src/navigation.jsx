import React from 'react'
import { PERMISSION_UUIDS } from './constants'
import {
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
  IconLock,
  IconSettings,
  IconShieldCheck
} from './components/common/Icons'

/*
 * ==================================================================================================
 * THE NAVIGATION MODEL, LIFTED OUT OF App.jsx.
 * ==================================================================================================
 *
 * It lived beside the shell that rendered it for as long as the shell was the only thing that read
 * it. It is now read by three: the sidebar draws it, the search palette indexes it, and App still
 * uses it to decide where to send a session that loses the page it is on. Importing App.jsx from a
 * component App.jsx renders is a cycle, so the list moved to the leaf.
 *
 * `TABS` and `tabIsVisible` are re-exported from App.jsx unchanged, because the tests that grew up
 * around them import from there and the move is not what they are about.
 */

/*
 * ==================================================================================================
 * THE GROUPS, AND WHY THEY ARE NOT THE OLD ORDER WITH LINES DRAWN IN IT.
 * ==================================================================================================
 *
 * Thirteen pages in one flat strip is thirteen things to read before you can rule twelve of them
 * out. Grouping only helps if a reader can predict which group a page is in WITHOUT having read the
 * groups first, so each of these answers one question and the questions do not overlap:
 *
 *   Assets         -- what is out there? The physical estate, and its lifecycle.
 *   Modelling      -- what does it MEAN? The contracts and vocabularies data is read through.
 *   History        -- what happened? Every page here is a record of the past, not a live view.
 *   Administration -- who may do what, and how is the platform configured?
 *
 * Overview is deliberately in NO group. It is the landing page and the only one that answers "how
 * is everything right now", which is not a subject so much as the absence of one -- and a group of
 * one is a separator that buys nothing.
 *
 * THE TWO PLACEMENTS WORTH DEFENDING:
 *
 *   ARCHIVES IS AN ASSET PAGE, not an administration one, even though it is permission-gated. It
 *   lists archived CELLS, GATEWAYS AND DEVICES with a Restore button -- the same three subjects as
 *   the three pages above it, at the end of their life. Grouping by who may SEE a page rather than
 *   by what it is ABOUT would pull Capture and Cold Storage in here too, and then the group means
 *   nothing except "restricted".
 *
 *   DIGITAL THREAD LEADS History RATHER THAN SITTING BESIDE Devices. It is the audit trace of every
 *   entity, so filing it under any one subject would be a claim about which subject it belongs to.
 *   What it shares with Capture and Cold Storage is the tense: all three answer questions about
 *   what already happened.
 *
 * THE GROUPS ARE NOT CAPTIONED IN THE RAIL, and the names above are for whoever edits this file.
 * They were rendered as headings and are not any more, because a heading has to earn its line and
 * these did not: four words that never change, above four lists whose members already say what they
 * are. `Cells / Gateways / Devices / Archives` is legible as a group of related things from the
 * separator alone, and a reader who needs the word "Assets" to see that is not helped by it.
 *
 * The cost of the captions was not only their own height. They had to hold their box in the
 * collapsed state so the items below them did not jump on hover, which meant the resting rail --
 * the state it is in almost all of the time -- carried four blank 23px strips whose only purpose was
 * to be somewhere for text to appear later.
 *
 * SO THE SEPARATOR IS NOW THE WHOLE OF THE GROUPING, in both states, which is what it already was
 * in the one that matters.
 */
export const NAV_GROUPS = [
  { id: 'home' },
  // Added with the Approvals page. It holds one entry, which the note above argues against for
  // Overview -- and the argument does not transfer, because the two are different shapes. Overview
  // is the LANDING page and a separator above the first item would be a line under nothing.
  // Approvals is a WORK QUEUE: it answers "what is waiting for me", which is the one question none
  // of the four subject groups asks, and the rows behind it are devices, nameplates and schemas at
  // once -- so filing it under any subject would be a claim about which subject it belongs to.
  //
  // It is not in `admin`, which was the other candidate. That group is Administrator-only, and this
  // is the one page an OPERATOR has something to do on: it would be the sole entry that role could
  // open in a group it can otherwise never see, and the group would stop meaning "how the platform
  // is configured".
  { id: 'work' },
  { id: 'assets' },
  { id: 'model' },
  { id: 'history' },
  { id: 'admin' }
]

export const TABS = [
  { id: 'overview',       label: 'Overview',       group: 'home',    icon: <IconLayoutDashboard size={16} /> },
  // GATED ON `proposal:create`, WHICH IS THE PERMISSION TO HAVE A REASON TO BE HERE. An Auditor
  // holds neither it nor a decision gate, and the RLS policy returns them their own proposals --
  // of which they can have none. The page would be permanently empty, which reads as a broken
  // page rather than as one that is not theirs.
  { id: 'approvals',      label: 'Approvals',      group: 'work',    icon: <IconShieldCheck size={16} />, permission: PERMISSION_UUIDS.PROPOSAL_CREATE },

  { id: 'cells',          label: 'Cells',          group: 'assets',  icon: <IconFactory size={16} /> },
  { id: 'gateways',       label: 'Gateways',       group: 'assets',  icon: <IconRadio size={16} /> },
  { id: 'devices',        label: 'Devices',        group: 'assets',  icon: <IconCpu size={16} /> },
  // NOT "Cold Storage", WHICH IS TWO GROUPS DOWN. This one means ENTITY archives -- archived cells,
  // gateways and devices, with a Restore button and an auto-purge timer. That one is telemetry
  // tiered to Parquet on object storage, with no restore and no timer. The two share only the
  // English word, and the labels keep them apart deliberately.
  { id: 'archives',       label: 'Archives',       group: 'assets',  icon: <IconArchive size={16} />, permission: PERMISSION_UUIDS.ARCHIVE_MANAGE },

  { id: 'schemas',        label: 'Schemas',        group: 'model',   icon: <IconClipboardList size={16} /> },
  // Split out of Schemas: the registry and catalog are state you edit, the vocabularies are
  // reference you read, and the reference half grows with every standard adopted.
  { id: 'vocabulary',     label: 'Vocabulary',     group: 'model',   icon: <IconFileCode size={16} /> },
  { id: 'directory',      label: 'Directory',      group: 'model',   icon: <IconBookOpen size={16} /> },

  { id: 'digital-thread', label: 'Digital Thread', group: 'history', icon: <IconHistory size={16} /> },
  // THE THREE ROLES THE DATABASE ADMITS, named here rather than reduced to one. Archived migration
  // 0055 grants SELECT on `captures` and `capture_jobs` to Administrator, Shopfloor_Manager and
  // Auditor; the first two can also record and delete. Operator is absent from both, which is why
  // the page is gated at all -- an Operator opening it would see an empty table and no explanation,
  // because RLS returns no rows rather than an error.
  { id: 'capture',        label: 'Capture',        group: 'history', icon: <IconRecord size={16} />, role: ['Administrator', 'Shopfloor_Manager', 'Auditor'] },
  // THE SAME THREE ROLES `cold_storage_rows()` RETURNS ROWS TO, and the function checks them in its
  // own body rather than relying on this: the catalogue names object keys, and the bucket policy
  // admits exactly these three to read what those keys point at.
  { id: 'cold-storage',   label: 'Cold Storage',   group: 'history', icon: <IconDatabase size={16} />, role: ['Administrator', 'Shopfloor_Manager', 'Auditor'] },

  // GATED ON THE ROLE, NOT ON A PERMISSION, because the DATABASE gates on the role. Inventing a
  // SETTINGS_MANAGE permission for the UI would mean two different predicates deciding the same
  // question, and the day they disagree the page is visible and every save fails.
  //
  // Access Control is deliberately NARROWER than the API behind it: its two RPCs admit
  // Administrator and Shopfloor_Manager, but seeing who holds what is an access-control question,
  // and a Shopfloor_Manager who needs to issue a credential still can, from Gateways.
  { id: 'access-control', label: 'Access Control', group: 'admin',   icon: <IconLock size={16} />, role: 'Administrator' },
  { id: 'settings',       label: 'Settings',       group: 'admin',   icon: <IconSettings size={16} />, role: 'Administrator' }
]

/**
 * Whether a page appears in the navigation.
 *
 * IT IS ONLY A COURTESY. Hiding a page removes a signpost, not an ability: the same PATCH can be
 * sent with curl, and what refuses it is the RLS policy. Nothing here is a security control, and
 * treating it as one is how a UI gate ends up being the ONLY gate.
 */
export function tabIsVisible(tabDef, hasPermission, userRole) {
  // `role` TAKES A LIST AS WELL AS A STRING. Most pages that have one name a single role, and the
  // Capture page cannot: SELECT on `captures` is granted to Administrator, Shopfloor_Manager AND
  // Auditor, so a single-role gate would either hide the page from two roles the database admits
  // or invent a permission that no policy consults -- which is two predicates deciding one
  // question, and the day they disagree the page is visible and every call fails.
  if (tabDef.role) {
    const allowed = Array.isArray(tabDef.role) ? tabDef.role : [tabDef.role]
    if (!allowed.includes(userRole)) return false
  }
  if (!tabDef.permission) return true
  return hasPermission(tabDef.permission)
}

/**
 * The visible pages, bucketed into the groups above, with empty groups dropped.
 *
 * EMPTY GROUPS ARE DROPPED RATHER THAN RENDERED EMPTY, and that is the whole reason this is a
 * function rather than a constant. An Operator sees no Administration page at all, and a heading
 * with a separator and nothing under it reads as a page that failed to load.
 */
export function groupedNav(visibleTabs) {
  return NAV_GROUPS
    .map(group => ({ ...group, tabs: visibleTabs.filter(t => t.group === group.id) }))
    .filter(group => group.tabs.length > 0)
}
