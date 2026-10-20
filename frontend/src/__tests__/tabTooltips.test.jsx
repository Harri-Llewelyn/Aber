import { describe, it, expect } from 'vitest'

import { PEOPLE_SECTION, SECTIONS } from '../components/tabs/AccessControlTab'
import { QUEUES } from '../components/tabs/ApprovalsTab'
import { STAGES } from '../components/tabs/ArchivesTab'
import { SUBJECTS } from '../components/tabs/CaptureTab'
import { VIEWS as DEVICE_VIEWS } from '../components/tabs/DevicesTab'
import { SERVICE_GROUPS, UNGROUPED_DESCRIPTION } from '../components/tabs/DirectoryTab'
import { VIEWS as METRIC_VIEWS } from '../components/tabs/MetricsTab'
import { PROFILE_SECTIONS } from '../components/tabs/ProfileTab'
import { CATEGORY_DESCRIPTIONS } from '../components/tabs/SettingsTab'

/**
 * Every tab tooltip a page writes by hand. A tab's tooltip appears whenever the pointer rests on
 * the tab bar, so it is plain sentences of 20 words at most, with no code; anything longer goes on
 * the page's help page. Vocabulary's tooltips are each standard's hint, checked in
 * VocabularyTab.test.jsx.
 */
const TOOLTIPS = [
  ...[PEOPLE_SECTION, ...SECTIONS].map(t => [`Access Control: ${t.label}`, t.description]),
  ...QUEUES.map(t => [`Approvals: ${t.label}`, t.description]),
  ...STAGES.map(t => [`Archived Entities: ${t.label}`, t.description]),
  ...SUBJECTS.map(t => [`Capture: ${t.label}`, t.description]),
  ...DEVICE_VIEWS.map(t => [`Devices: ${t.label}`, t.description]),
  ...SERVICE_GROUPS.map(g => [`Directory: ${g.title}`, g.description]),
  ['Directory: Other Registered Services', UNGROUPED_DESCRIPTION],
  ...METRIC_VIEWS.map(t => [`Metrics: ${t.label}`, t.description]),
  ...PROFILE_SECTIONS.map(t => [`Profile: ${t.label}`, t.description]),
  ...Object.entries(CATEGORY_DESCRIPTIONS).map(([category, text]) => [`Settings: ${category}`, text]),
]

describe('every tab tooltip', () => {
  it.each(TOOLTIPS)('%s is plain sentences of 20 words at most', (_, text) => {
    expect(typeof text).toBe('string')
    expect(text.trim().split(/\s+/).length).toBeLessThanOrEqual(20)
    expect(text).toMatch(/^[A-Z].*\.$/)
    // No code: no identifiers in backticks, no paths, no environment variable names.
    expect(text).not.toMatch(/[`/_]|\w\.\w/)
  })

  it('covers every tab of the pages it lists', () => {
    expect(TOOLTIPS).toHaveLength(5 + 2 + 2 + 2 + 2 + 4 + 3 + 2 + 5)
  })

  it('has a sentence for each Settings category the database seeds', () => {
    // Backups' settings are all edited in its destination dialog, so it never shows a tab.
    expect(Object.keys(CATEGORY_DESCRIPTIONS).sort()).toEqual(['Approvals', 'Audit Trail', 'Cold Storage', 'Retention', 'Site'])
  })
})
