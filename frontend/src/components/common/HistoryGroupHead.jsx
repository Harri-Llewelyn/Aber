import React from 'react'
import { GroupHeading } from './GroupHeading'
import { SegmentedControl } from './SegmentedControl'

/**
 * A group's heading row on History's chart pages: the GroupHeading that opens and closes the
 * group, and at the row's right-hand end the group's bucket choice, one SegmentedControl of Auto
 * and each size (utils/history.js, bucketOptions()). The row wraps below the heading on a narrow
 * card, the switch staying at the right. It pins under the page's time axis (App.css).
 *
 * `buckets` is `{ label, value, options, onChange }`: the switch's name for assistive technology
 * ("Double buckets"), the chosen id, its options, and what a choice calls with the id. A page
 * with no choice to offer leaves it out. The rest is GroupHeading's: `open`, `onToggle`, `label`,
 * `count`, `countLabel`, `detail` and `controls`. The switch is beside the heading, not in it,
 * since a button holds no other control.
 *
 *   <HistoryGroupHead open={open} onToggle={toggle} label="Double" count={3} detail="5-minute buckets"
 *     controls={id} buckets={{ label: 'Double buckets', value: 'auto', options, onChange: choose }} />
 */
export function HistoryGroupHead({ buckets = null, ...heading }) {
  return (
    <div className="history-group-head">
      <GroupHeading {...heading} />
      {buckets && (
        <SegmentedControl label={buckets.label} options={buckets.options} value={buckets.value} onChange={buckets.onChange} />
      )}
    </div>
  )
}
