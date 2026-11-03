/**
 * What revoking a machine identity's token reaches, said the same way in every token dialog.
 * PostgREST's auth_pre_request() refuses a revoked jti, and i3X (within its 15-second cache), aas-api
 * and the Factory+ Directory check each caller through PostgREST. Storage and realtime verify the
 * signature alone. The other edge functions and Studio accept no machine token at all, so they are no
 * gap and go unnamed.
 */
export const REVOCATION_REACHES = 'the API, i3X, the AAS API and the Factory+ Directory'

/** The services that verify only the signature, so for them a token's expiry is the only limit. */
export const SIGNATURE_ONLY = 'Storage and realtime'
