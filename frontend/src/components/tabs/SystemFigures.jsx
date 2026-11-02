import React, { useCallback, useState } from 'react'
import { api } from '../../api'
import { grafanaPanelUrl } from '../../constants'
import { usePolling } from '../../hooks/usePolling'
import { SummaryCard, SummaryCards } from '../common/SummaryCard'
import { formatClockTime } from '../../utils/format'
import {
  FIGURE_PANELS,
  FIGURES_POLL_MS,
  NOT_OBSERVED,
  figureValue,
  figuresByKey,
  formatCount,
  formatRate,
  ingestionLinks,
  largestRefusal,
  messageTypeSplit,
  messagesLost,
} from '../../utils/systemFigures'

const Unobserved = () => <span className="system-unobserved">{NOT_OBSERVED}</span>

const PROMETHEUS_UNOBSERVED = 'Not observed: Prometheus gave no answer for it in the last minute.'

/** "As of 14:30." for a Prometheus figure; nothing without a time. */
const asOf = (row) => (row?.observed_at ? `As of ${formatClockTime(row.observed_at)}.` : null)

/**
 * Each read on its own, so one failing leaves the others standing: a historian outage fails the
 * device count and nothing else. A failed read is null, which the tile says is not observed.
 * `failure` is the figures table's own read failing, which is the platform database or the API
 * failing, and the only one the poll reports: the device count fails with the historian alone.
 */
async function readFigures() {
  const [figures, gateways, devices] = await Promise.allSettled([
    api.systemFigures(),
    api.gatewayCounts(),
    api.devicesReporting(),
  ])
  return {
    figures: figures.status === 'fulfilled' ? figuresByKey(figures.value) : {},
    gateways: gateways.status === 'fulfilled' ? gateways.value : null,
    devices: devices.status === 'fulfilled' && Number.isInteger(devices.value) ? devices.value : null,
    failure: figures.status === 'rejected' ? figures.reason : null,
  }
}

/**
 * The figures above the Ingestion & Messaging tab's table: what the stack is doing now. Latest
 * values only; a tile whose history is a Grafana panel opens it, when this browser can reach
 * Grafana (`grafanaOpen`).
 */
export function SystemFigures({ grafanaOpen }) {
  const [read, setRead] = useState(null)

  const load = useCallback(async () => {
    const next = await readFigures()
    setRead(next)
    if (next.failure) throw next.failure
  }, [])
  usePolling(load, FIGURES_POLL_MS)

  if (!read) return null
  const { figures, gateways, devices } = read
  const href = (panel) => (grafanaOpen ? grafanaPanelUrl(panel) : undefined)
  const linked = (panel, tip) => (grafanaOpen && panel ? [...tip, 'Opens its history in Grafana.'] : tip)

  const messages = figures.messages_per_second
  const messagesValue = figureValue(messages)
  const readings = figures.readings_per_second
  const readingsValue = figureValue(readings)
  const lost = messagesLost(figures)
  const lostRow = [figures.messages_refused_last_hour, figures.messages_shed_last_hour, figures.messages_missed_last_hour]
    .find(row => figureValue(row) !== null)
  const refusal = largestRefusal(figures.messages_refused_last_hour)
  const links = ingestionLinks(figures)
  const linksUp = links ? Number(links.broker) + Number(links.historian) : null
  const linkDown = links && [!links.broker && 'Broker', !links.historian && 'Historian'].filter(Boolean)

  return (
    <SummaryCards label="What the stack is doing" testId="system-figures">
      <SummaryCard
        title="Messages received"
        testId="figure-messages"
        value={messagesValue === null ? <Unobserved /> : formatRate(messagesValue)}
        unit={messagesValue === null ? undefined : 'messages/s'}
        detail="Sparkplug, over 5 minutes"
        tip={[
          'Sparkplug messages the ingestion service acted on, per second, averaged over the last 5 minutes.',
          messagesValue === null ? PROMETHEUS_UNOBSERVED : messageTypeSplit(messages),
          asOf(messages),
        ]}
      />
      <SummaryCard
        title="Readings written"
        testId="figure-readings"
        value={readingsValue === null ? <Unobserved /> : formatRate(readingsValue)}
        unit={readingsValue === null ? undefined : 'readings/s'}
        detail="To the historian, over 5 minutes"
        href={href(FIGURE_PANELS.readings)}
        tip={linked(FIGURE_PANELS.readings, [
          'Readings, one metric value each, that the ingestion service wrote to the historian, per second, averaged over the last 5 minutes.',
          readingsValue === null ? PROMETHEUS_UNOBSERVED : asOf(readings),
        ])}
      />
      <SummaryCard
        title="Messages lost, last hour"
        testId="figure-lost"
        wide
        value={(
          <span className="system-lost">
            {lost.map(part => (
              <span key={part.label} data-testid={`figure-lost-${part.label}`}>
                {part.value === null ? <Unobserved /> : formatCount(part.value)}
              </span>
            ))}
          </span>
        )}
        detail={(
          <span className="system-lost">
            {lost.map(part => <span key={part.label}>{part.label}</span>)}
          </span>
        )}
        href={href(FIGURE_PANELS.lost)}
        tip={linked(FIGURE_PANELS.lost, [
          'Three counts that overlap, so they are never added up. Refused by the ingestion service. Shed by the broker for a slow subscriber. Missed: gaps in Sparkplug sequence numbers.',
          refusal ? `Most refused: ${refusal.reason} (${formatCount(refusal.count)}).` : null,
          lostRow ? asOf(lostRow) : PROMETHEUS_UNOBSERVED,
        ])}
      />
      <SummaryCard
        title="Ingestion links"
        testId="figure-links"
        value={links ? `${linksUp} of 2` : <Unobserved />}
        unit={links ? 'connected' : undefined}
        detail="To the broker and the historian"
        state={linkDown?.length ? `${linkDown.join(' and ')} not connected` : undefined}
        tone={linkDown?.length ? 'danger' : undefined}
        tip={[
          'Whether the ingestion service is subscribed to the broker and connected to the historian. With either one down, readings are not being recorded.',
          links ? asOf(figures.ingestion_broker_link) : PROMETHEUS_UNOBSERVED,
        ]}
      />
      <SummaryCard
        title="Gateways online"
        testId="figure-gateways"
        value={gateways ? gateways.online.toLocaleString('en-GB') : <Unobserved />}
        unit={gateways ? `of ${gateways.enrolled.toLocaleString('en-GB')} enrolled` : undefined}
        detail="Reporting now"
        href={href(FIGURE_PANELS.gateways)}
        tip={linked(FIGURE_PANELS.gateways, [
          'Gateways online now, of those enrolled. Archived gateways, the Playback gateway and gateways awaiting setup are not counted.',
          gateways ? null : 'Not observed: the gateway count could not be read.',
        ])}
      />
      <SummaryCard
        title="Devices reporting"
        testId="figure-devices"
        value={devices === null ? <Unobserved /> : devices.toLocaleString('en-GB')}
        unit={devices === null ? undefined : (devices === 1 ? 'device' : 'devices')}
        detail="In the last 5 minutes"
        href={href(FIGURE_PANELS.devices)}
        tip={linked(FIGURE_PANELS.devices, [
          'Devices with at least one reading in the last 5 minutes, read from the historian.',
          devices === null ? 'Not observed: the historian could not be read.' : null,
        ])}
      />
    </SummaryCards>
  )
}
