import React from 'react'
import { IconUser, IconLock, IconAlertTriangle } from '../common/Icons'
import { CardHeading } from '../common/CardHeading'
import { TabStrip } from '../common/TabStrip'
import { useUrlTab } from '../../hooks/useUrlState'
import { SIDEBAR_MODES } from '../../hooks/useSidebarMode'
import { MIN_PASSWORD_LENGTH } from '../../utils/passwords'

/** The page's tabs. The ids are the page's anchors: the search bar opens one by id. */
export const PROFILE_SECTIONS = [
  { id: 'account', label: 'Account' },
  { id: 'appearance', label: 'Appearance' },
]

const THEME_OPTIONS = [
  { id: 'dark', label: 'Dark' },
  { id: 'light', label: 'Light' },
]

/** One row of the Settings page's table: the name, what it does, its value, and what can be done. */
function ProfileRow({ id, label, description, value, actions }) {
  return (
    <tr className="setting-row" data-profile-setting={id}>
      <td className="setting-cell setting-cell-name">
        {/* A label only where the value is a field: a label for nothing is no label at all. */}
        {typeof value === 'string'
          ? <span className="setting-label">{label}</span>
          : <label className="setting-label" htmlFor={`profile-${id}`}>{label}</label>}
      </td>
      <td className="setting-cell setting-cell-description">
        <p className="setting-description">{description}</p>
      </td>
      <td className="setting-cell setting-cell-value">
        {typeof value === 'string' ? <span className="profile-value">{value}</span> : value}
      </td>
      <td className="setting-cell setting-cell-actions">{actions}</td>
    </tr>
  )
}

/** The four columns, with their header row even for a tab of one row. */
function ProfileTable({ children }) {
  return (
    <div className="table-wrap settings-wrap">
      <table className="settings-table">
        <thead>
          <tr>
            <th scope="col" className="setting-col-name">Setting</th>
            <th scope="col">Description</th>
            <th scope="col" className="setting-col-value">Value</th>
            <th scope="col" className="setting-col-actions">Actions</th>
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  )
}

/**
 * The signed-in person's own page: who they are signed in as, and how the dashboard looks to them.
 * Reached from the account menu at the foot of the sidebar, not from the page list. Appearance is
 * the person's `user_settings` row (useUserSettings.js), so it follows them to any browser.
 *
 * `settingsSource` is that hook's `source`; 'browser' means the row could not be read or written.
 * `passwordBlocked` is why Change Password is unavailable (a machine identity), or null.
 * `userRole` is undefined while it is still being read, and null for an account with no role.
 * The tab is the path: `/profile/appearance`.
 */
export function ProfileTab({
  email, userRole, passwordBlocked = null, onChangePassword,
  theme, onChangeTheme, sidebarMode, onChangeSidebarMode, settingsSource = 'account',
}) {
  const [section, setSection] = useUrlTab('profile', PROFILE_SECTIONS.map(s => s.id), PROFILE_SECTIONS[0].id)

  const mode = SIDEBAR_MODES.find(m => m.id === sidebarMode) || SIDEBAR_MODES[0]

  return (
    <div className="page-layout page-fill">
      <div className="page-main">
        <div className="card card-fill">
          <CardHeading
            icon={<IconUser size={15} />}
            title="Profile"
            description="Your account, and how the dashboard looks to you."
            note="Applies to you, on any browser."
          />

          <TabStrip
            ariaLabel="Profile section"
            value={section}
            onChange={setSection}
            tabs={PROFILE_SECTIONS}
          />

          {section === 'account' && (
            <ProfileTable>
              <ProfileRow
                id="email"
                label="Email address"
                description="The address you sign in with."
                value={email || 'None: this identity signs in with a token'}
              />
              <ProfileRow
                id="role"
                label="Role"
                description="What you may see and change across the site. A page your role cannot use is left out of the sidebar."
                value={userRole === undefined ? 'Loading…' : userRole ? userRole.replace(/_/g, ' ') : 'No role'}
                actions={<span className="setting-fixed">Only an Administrator can change this</span>}
              />
              <ProfileRow
                id="password"
                label="Password"
                description={`Give your current password, then the new one twice. It needs at least ${MIN_PASSWORD_LENGTH} characters. Your other sessions are signed out.`}
                value={passwordBlocked ? 'None' : 'Never shown'}
                actions={(
                  <div className="setting-actions">
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={onChangePassword}
                      disabled={!!passwordBlocked}
                      title={passwordBlocked || 'Change the password you sign in with'}
                    >
                      <IconLock size={13} /> Change Password
                    </button>
                  </div>
                )}
              />
            </ProfileTable>
          )}

          {section === 'appearance' && (<>
            {/* Said only when it is true: a quiet page means the row was read and each change is
                saved to it. */}
            {settingsSource === 'browser' && (
              <div className="card-body profile-source">
                <div className="callout callout-warning" role="status">
                  <IconAlertTriangle size={14} className="callout-icon" />
                  <div>
                    Your choices could not be read from your account, so this browser&apos;s are shown.
                    A change you make now applies in this browser only.
                  </div>
                </div>
              </div>
            )}
            <ProfileTable>
              <ProfileRow
                id="theme"
                label="Theme"
                description="Dark or light colours. The Theme item in the account menu switches the same setting."
                value={(
                  <select
                    id="profile-theme"
                    className="form-control"
                    value={theme}
                    onChange={e => onChangeTheme?.(e.target.value)}
                  >
                    {THEME_OPTIONS.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
                  </select>
                )}
              />
              <ProfileRow
                id="sidebar"
                label="Sidebar layout"
                description="How the sidebar shows the page names. The control at the foot of the sidebar switches the same setting."
                value={(<>
                  <select
                    id="profile-sidebar"
                    className="form-control"
                    value={mode.id}
                    onChange={e => onChangeSidebarMode?.(e.target.value)}
                    aria-describedby="profile-sidebar-detail"
                  >
                    {SIDEBAR_MODES.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
                  </select>
                  <div id="profile-sidebar-detail" className="setting-bounds profile-detail">{mode.description}</div>
                </>)}
              />
            </ProfileTable>
          </>)}
        </div>
      </div>
    </div>
  )
}
