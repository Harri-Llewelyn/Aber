import { refusalOf } from "./refusals.ts";

// Local rather than an assertion library: a test import would enter deno.lock and the image's graph.
function equal(actual: unknown, expected: unknown, message = "") {
  const [a, e] = [JSON.stringify(actual), JSON.stringify(expected)];
  if (a !== e) throw new Error(`${message ? `${message}: ` : ""}expected ${e}, got ${a}`);
}

/** The sentences a person can act on, as the database words them, by the code it raises. */
const SHOWN: [string, string][] = [
  ["23514", 'device "Lathe 1" cannot be put in cell "Old Bay", which is archived. Restore the cell first, or choose another.'],
  ["23514", 'device "Lathe 1" cannot be assigned to gateway "Old Line", which is archived. Restore the gateway first, or choose another.'],
  ["23514", 'area "Old Hall" is archived, so device "Lathe 1" cannot be made Area-Wide in it. Restore the area first, or choose another.'],
  ["P0001", '"Lathe 1" is not in Quarantine, so it was not merged. It may have been approved since the list was read.'],
  ["P0001", '"Lathe 1" was registered before it was held in Quarantine, so it was not merged. Merging deletes what is set on it, such as its schemas and nameplate. Approve it instead.'],
  ["P0001", '"Lathe 2" is archived, so nothing was merged into it. Restore it first.'],
  ["P0001", '"Lathe 2" is in Quarantine itself, so nothing was merged into it.'],
  ["P0001", '"Lathe 2" has already sent its first birth, so nothing was merged into it. It is a device of its own.'],
];

for (const [code, message] of SHOWN) {
  Deno.test(`a refusal a person can act on is answered 409 as it is worded: ${message.slice(0, 60)}`, () => {
    equal(refusalOf({ code, message }), { status: 409, error: message });
  });
}

/** What the caller is told of each refusal with a fixed sentence. The database's is never in it. */
const FIXED: [string, string, number, string][] = [
  ["P0002", "target device 5d000000-0000-4000-8000-000000000001 not found", 404, "Device not found"],
  ["42501", "actor 5d000000-0000-4000-8000-000000000001 is not permitted to approve quarantined devices", 403, "Forbidden: Insufficient privileges"],
  ["22023", "a cell device must name its cell", 400, "Invalid approval request"],
  ["22023", "an area_wide device must name its area", 400, "Invalid approval request"],
  ["22023", "cannot merge device 5d000000-0000-4000-8000-000000000001 into itself", 400, "Invalid approval request"],
];

for (const [code, message, status, error] of FIXED) {
  Deno.test(`${code} answers ${status} in a fixed sentence: ${message.slice(0, 40)}`, () => {
    equal(refusalOf({ code, message }), { status, error });
  });
}

/** A failure: not a refusal a person can act on, or one whose words name a table or a column. */
const FAILURES: [string | undefined, string | undefined][] = [
  ["23514", 'new row for relation "devices" violates check constraint "devices_cell_scope_names_a_cell"'],
  ["23514", 'new row for relation "devices" violates check constraint "devices_name_not_blank"'],
  // Two triggers' own words that name a table and a column. The dialog offers neither choice.
  ["23514", "devices: Playback is a playback gateway, and a device cannot be assigned to one. Its devices are REPLAY LANES -- each stands in for a real machine, and which machine is recorded in shadow_of. To replay onto this gateway, start a playback from the capture instead."],
  ["23514", "device Lane 1 is a replay lane and cannot be moved to another gateway. Nothing else can make a device a lane, change which machine it stands in for, or move it."],
  ["23503", 'insert or update on table "devices" violates foreign key constraint "devices_gateway_id_fkey"'],
  ["23505", 'duplicate key value violates unique constraint "asset_config_pkey"'],
  ["22P02", 'invalid input syntax for type uuid: "x"'],
  ["40P01", "deadlock detected"],
  ["57014", "canceling statement due to statement timeout"],
  ["23514", undefined],
  [undefined, "fetch failed"],
  [undefined, undefined],
];

for (const [code, message] of FAILURES) {
  Deno.test(`${code ?? "no code"} is a failure, not a refusal: ${(message ?? "no message").slice(0, 60)}`, () => {
    equal(refusalOf({ code, message }), null);
  });
}

Deno.test("a name that holds a refusal's words does not make a constraint's message one to show", () => {
  const message = 'new row for relation "devices" violates check constraint "devices_site_wide_has_no_cell" (Restore the cell first, or choose another.)';
  equal(refusalOf({ code: "23514", message }), null);
});
