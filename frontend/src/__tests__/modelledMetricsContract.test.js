/**
 * The JavaScript half of the modelled-metrics contract.
 * `ingestion/test_modelled_metrics_contract.py` asserts the same fixture in
 * `test-harness/fixtures/` against the Python mirror, so a change to one implementation fails until
 * the fixture is updated, and updating the fixture then fails the other.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { modelledMetrics } from '../utils/deviceTags'

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'test-harness', 'fixtures', 'modelled-metrics.json'
)
const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8'))

describe('modelledMetrics contract with ingestion/validate.py', () => {
  it('reads a non-empty fixture', () => {
    // A contract test that silently exercises nothing is worse than none: it reports green while
    // the two implementations drift freely.
    expect(fixture.cases.length).toBeGreaterThan(5)
  })

  for (const testCase of fixture.cases) {
    it(testCase.name, () => {
      const result = modelledMetrics({ schema_definition: testCase.schema_definition })
      if (testCase.expected === null) {
        // null means "declares neither, cannot be evaluated" -- NOT "models nothing". The
        // distinction is what stops a device with no usable schema being reported as Unmodelled.
        expect(result).toBeNull()
      } else {
        expect(result).not.toBeNull()
        expect([...result].sort()).toEqual([...testCase.expected].sort())
      }
    })
  }
})
