import { nameSimilarity } from './stringSimilarity'
import { isNeverSeen } from './deviceProvisioning'

const MIN_NAME_SIMILARITY = 0.5
const MIN_SCHEMA_OVERLAP = 0.5

function schemaRequiredOverlap(schema, reportedMetrics) {
  const required = schema?.schema_definition?.required
  if (!Array.isArray(required) || required.length === 0) return null
  const reported = new Set(reportedMetrics || [])
  const present = required.filter(r => reported.has(r))
  return { ratio: present.length / required.length, present: present.length, total: required.length }
}

/**
 * Rank provisioned-but-never-seen devices as possible matches for a quarantined device. A
 * schema-based metric match is weighted into the upper half of the score range, so any real metric
 * overlap outranks a name coincidence. A device that publishes a valid sparkplug_id resolves
 * exactly and never reaches the queue; what is compared here is the quarantined device's reported
 * label, since `asset_id` is the UUID of its own quarantine row.
 */
export function suggestMatches(quarantineItem, assets, schemas, { limit = 1 } = {}) {
  const candidates = (assets || []).filter(isNeverSeen)
  const schemasById = new Map((schemas || []).map(s => [s.schema_uuid, s]))
  const reportedMetrics = quarantineItem?.reported_metrics || []

  const scored = candidates.map(candidate => {
    const nameSim = nameSimilarity(quarantineItem?.asset_name, candidate.asset_name)
    const schema = candidate.schema_id ? schemasById.get(candidate.schema_id) : null
    const overlap = schema ? schemaRequiredOverlap(schema, reportedMetrics) : null

    let score
    let evidence
    if (overlap && overlap.ratio > 0) {
      score = 0.5 + overlap.ratio * 0.5
      evidence = `${overlap.present}/${overlap.total} required metrics present, ${Math.round(nameSim * 100)}% name match`
    } else {
      score = nameSim * 0.5
      evidence = `${Math.round(nameSim * 100)}% name match`
    }

    return { candidateId: candidate.asset_id, candidateName: candidate.asset_name, nameSim, overlap, score, evidence }
  })

  return scored
    .filter(s => s.nameSim >= MIN_NAME_SIMILARITY || (s.overlap && s.overlap.ratio >= MIN_SCHEMA_OVERLAP))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}
