/**
 * What an approval the database refused is answered with. A sentence written for the person is answered
 * as it is worded; every other failure keeps a fixed one, because a driver's message names tables,
 * columns and constraints. README.md lists each refusal on the path and which are answered.
 */

/** A database error, as the client reports it. */
export interface DbError {
  code?: string;
  message?: string;
}

export interface Refusal {
  status: number;
  error: string;
}

/**
 * How each sentence of a trigger that refuses an archived place ends: refuse_filing_in_an_archived_cell(),
 * refuse_assigning_to_an_archived_gateway() and refuse_area_wide_in_an_archived_area(). check_violation is
 * also the code of a CHECK constraint, which names itself and its table, and of a refusal that names a
 * column, so the code alone does not say that the sentence is one to show. Drift check 607 holds these.
 */
const ARCHIVED_PLACE = [
  "Restore the cell first, or choose another.",
  "Restore the gateway first, or choose another.",
  "Restore the area first, or choose another.",
];

/** The answer to a refusal, or null for a failure, which is not the caller's. */
export function refusalOf({ code, message = "" }: DbError): Refusal | null {
  switch (code) {
    case "P0002":
    case "no_data_found":
      return { status: 404, error: "Device not found" };
    case "42501":
      return { status: 403, error: "Forbidden: Insufficient privileges" };
    case "22023":
      return { status: 400, error: "Invalid approval request" };
    // raise_exception: a merge the RPC refuses, in a sentence written for the person.
    case "P0001":
      return { status: 409, error: message };
    case "23514":
      return ARCHIVED_PLACE.some((ending) => message.endsWith(ending)) ? { status: 409, error: message } : null;
    default:
      return null;
  }
}
