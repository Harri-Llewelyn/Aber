import React, { useMemo } from 'react'
import { TimeSeriesChart } from './TimeSeriesChart'
import { DeviceStatusDot } from './DeviceStatusDot'
import { OverflowText } from './OverflowText'
import { RouteLink } from './RouteLink'
import { DEVICE_STATUS, deviceLifecycleStatus } from '../../utils/deviceStatus'
import { chartSummary, readingWords, sharedScale, silentWords } from '../../utils/history'

/** A machine's title line: its status dot as the Site Map draws it, its name, and Offline in words. */
function MemberHead({ member }) {
  const offline = member.device && deviceLifecycleStatus(member.device) !== DEVICE_STATUS.ONLINE
  const name = <OverflowText className="multiple-name-text">{member.name}</OverflowText>
  return (
    <span className="multiple-name">
      {member.device && <DeviceStatusDot device={member.device} />}
      {member.to ? (
        <RouteLink to={member.to} className="multiple-link" title={`Chart ${member.name}'s readings over this window`}>{name}</RouteLink>
      ) : name}
      {offline && <span className="device-offline-word">Offline</span>}
    </span>
  )
}

/**
 * One metric across several members, a chart each, stacked on one time axis and on ONE value scale,
 * so the member that differs shows as it is: the lowest minimum to the highest maximum across them
 * all (sharedScale()), said in words above the charts. The Cell tab's machines are its members;
 * the Area and Metric tabs reuse it for theirs. A member with no `series` is not charted: it says
 * `absent` in words, or that it does not report the metric, never an empty chart.
 *
 * Each member is `{ key, name, device?, to?, series?, starts?, validRange?, read?, plugins?, absent? }`.
 * `series` and `starts` are what chartSeries() or changeSeries() give; `device` adds its status dot
 * and `to` makes its name a link; `read` is the read a text or flag chart shows when the page's
 * `stateLine` says another; `plugins` are its uPlot plugins, such as its alert bands. `resolution`
 * and `windowText` name the read in each chart's summary for a screen reader. The time axis, the
 * pointer, the zoom band and the unit are the page's: `syncKey` shares one pointer across the
 * charts, `band` is the drag's band (useChartBand()).
 *
 *   <SmallMultiples members={members} metric="Spindle/LOAD" unit="kW" start={s} end={e} now={now}
 *     resolution={resolution} windowText="Last 24 hours" syncKey="history-cell-c1" />
 */
export function SmallMultiples({
  members, metric, unit, start, end, now, resolution, windowText, syncKey, band = null, stateLine = null, height = 110,
}) {
  const charted = members.filter(m => m.series)
  // The scale by value: a chart is drawn again when its `yRange` is another array, so the same ends are the same one.
  const found = sharedScale(charted.map(m => m.series))
  const ends = found ? `${found[0]},${found[1]}` : ''
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const scale = useMemo(() => found, [ends])
  const span = { start, end, now }
  return (
    <div className="multiples">
      {scale && charted.length > 1 && (
        <p className="multiples-scale">
          {`One scale for every machine: ${readingWords(scale[0])} to ${readingWords(scale[1], unit)}.`}
        </p>
      )}
      {members.map(m => {
        if (!m.series) {
          return (
            <p key={m.key} className="multiple-absent">
              {m.device && <DeviceStatusDot device={m.device} />}
              {m.absent ?? silentWords(m.name, metric)}
            </p>
          )
        }
        const summary = chartSummary({
          metric, unit, windowText, resolution, series: m.series, validRange: m.validRange ?? null, starts: m.starts, span, read: m.read ?? null,
        })
        return (
          <TimeSeriesChart
            key={m.key}
            metric={metric}
            unit={unit}
            label={m.name}
            head={<MemberHead member={m} />}
            starts={m.starts}
            series={m.series}
            start={start}
            end={end}
            now={now}
            minutes={resolution.minutes}
            validRange={m.validRange ?? null}
            yRange={scale}
            height={height}
            summary={`${m.name}. ${summary}`}
            syncKey={syncKey}
            band={band}
            plugins={m.plugins}
            note={m.read && m.read !== stateLine ? m.read : null}
          />
        )
      })}
    </div>
  )
}
