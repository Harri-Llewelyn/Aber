import React from 'react'
import { Tooltip } from './Tooltip'
import { DEVICE_STATUS, deviceDotStyle, deviceLifecycleStatus, deviceStatusTitle } from '../../utils/deviceStatus'

/**
 * A device's status dot as the Site Map draws it, with its tooltip. Never colour alone: an online
 * device says so to a screen reader, and an offline or quarantined one is worded beside its name
 * by the caller (`deviceLifecycleStatus()`).
 */
export function DeviceStatusDot({ device }) {
  const status = deviceLifecycleStatus(device)
  return (
    <Tooltip text={deviceStatusTitle(status)}>
      <span className="device-status-dot" tabIndex={0}>
        <span className="badge-dot" style={deviceDotStyle(device)} aria-hidden="true" />
        {status === DEVICE_STATUS.ONLINE && <span className="sr-only">Online</span>}
      </span>
    </Tooltip>
  )
}
