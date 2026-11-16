import { decodeList, encodeList } from '../hooks/useUrlState'
import { OUT_OF_VOCABULARY_TAG, UNMODELLED_TAG } from './deviceTags'

/** The Status filter's values for the two findings. */
export const STATUS_UNMODELLED = 'unmodelled'
export const STATUS_OUT_OF_VOCABULARY = 'out_of_vocabulary'

/** An old `?type=` value that is a finding, and the Status value that now holds it. */
const FINDING_STATUS = new Map([
  [UNMODELLED_TAG, STATUS_UNMODELLED],
  [OUT_OF_VOCABULARY_TAG, STATUS_OUT_OF_VOCABULARY]
])

const union = (a, b) => [...new Set([...a, ...b])]

/**
 * The query changes that bring an old Devices link up to date, for `withQuery`; null when the
 * address needs none. The Type filter is now Metric groups (`?group=`), and the two findings it
 * once offered are Status values, so `?type=Unmodelled` is `?status=unmodelled`.
 */
export function oldDevicesLinkChanges(query) {
  const changes = {}

  const type = query.get('type')
  if (type !== null) {
    const old = decodeList(type)
    const statuses = old.filter(v => FINDING_STATUS.has(v)).map(v => FINDING_STATUS.get(v))
    const groups = old.filter(v => !FINDING_STATUS.has(v))
    changes.type = null
    if (groups.length) changes.group = encodeList(union(decodeList(query.get('group') ?? ''), groups))
    if (statuses.length) changes.status = encodeList(union(decodeList(query.get('status') ?? ''), statuses))
  }

  return Object.keys(changes).length ? changes : null
}
