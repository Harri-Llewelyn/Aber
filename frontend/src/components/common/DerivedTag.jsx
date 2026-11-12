import React from 'react'
import { Badge } from './Badge'

/** What the tag's tooltip says: where the value comes from, in the words the Metrics page used first. */
export const DERIVED_TAG_TITLE = 'Aber computes this metric from others. Its drawer has the definition.'

/**
 * The small tag that marks a derived metric wherever one is named, so nobody mistakes it for
 * something the machine said: the Metrics page's tables, History's pickers and chart titles, and the
 * Devices drawer. Text, never a colour alone. One component, so every place says it alike.
 */
export function DerivedTag({ size = 'sm', className }) {
  return <Badge tone="neutral" size={size} title={DERIVED_TAG_TITLE} className={className}>Derived</Badge>
}
