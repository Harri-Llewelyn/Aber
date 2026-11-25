/**
 * What a device's Digital Nameplate must hold before its AAS export names the template (IDTA 02006).
 * The exporter decides it, per device, as it exports (`mandatoryNameplatePaths()` in
 * supabase/functions/_shared/aas/shell.ts). The dialog works it out from the same rows, so it can say
 * what is still empty before anything is exported.
 */

/**
 * The address elements a nameplate must have. The template's specification names the four and no
 * template file does: Contact Information, which defines them, marks each one optional. Mirrors
 * MANDATORY_ADDRESS_ELEMENTS in shell.ts (mirror check 160).
 */
export const MANDATORY_ADDRESS_ELEMENTS = ['Street', 'Zipcode', 'CityTown', 'NationalCode']

const ADDRESS_INFORMATION = 'AddressInformation'

/**
 * The elements the template asks for, as paths in its order: its top-level elements of cardinality One or
 * OneToMany, with AddressInformation as the address elements above. `elements` is the Nameplate's rows of
 * `idta_template_elements`. Empty without them.
 */
export function mandatoryNameplatePaths(elements, templateId) {
  return (elements || [])
    .filter(e => e.template_id === templateId && e.parent_path === null
      && (e.cardinality === 'One' || e.cardinality === 'OneToMany'))
    .sort((a, b) => a.ordinal - b.ordinal)
    .flatMap(e => (e.path === ADDRESS_INFORMATION
      ? MANDATORY_ADDRESS_ELEMENTS.map(name => `${ADDRESS_INFORMATION}.${name}`)
      : [e.path]))
}

/** Whether a nameplate value is one: spaces are none, as the exporter reads them. */
export const hasNameplateValue = value => value !== null && value !== undefined && String(value).trim() !== ''
