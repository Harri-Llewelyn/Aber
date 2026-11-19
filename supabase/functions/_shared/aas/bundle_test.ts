import { HOURLY_COLUMNS, loadTelemetry, RAW_COLUMNS } from "./bundle.ts";

// Local rather than an assertion library: a test import would enter deno.lock and the image's graph.
const assert = {
  equal(actual: unknown, expected: unknown, message = "") {
    const [a, e] = [JSON.stringify(actual), JSON.stringify(expected)];
    if (a !== e) throw new Error(`${message ? `${message}: ` : ""}expected ${e}, got ${a}`);
  },
};

type Row = Record<string, unknown>;

/**
 * A client answering telemetry_page() and telemetry_rollup_page() as 0315 declares them, for one
 * relation's rows: the asset's, at or before p_to, newest first with ties in metric order, at most
 * p_limit. It records each call's function, arguments and select.
 */
function pageClient(rows: Row[], timeColumn: "time" | "bucket") {
  const calls: { fn: string; args: Row; select: string }[] = [];
  const client = {
    rpc(fn: string, args: Row) {
      return {
        select(columns: string) {
          calls.push({ fn, args, select: columns });
          const page = rows
            .filter((r) => r.asset_id === args.p_asset_id)
            .filter((r) => args.p_to === undefined || String(r[timeColumn]) <= String(args.p_to))
            .sort((a, b) =>
              String(b[timeColumn]).localeCompare(String(a[timeColumn])) ||
              String(a.metric_name).localeCompare(String(b.metric_name))
            )
            .slice(0, Number(args.p_limit))
            .map((r) => Object.fromEntries(columns.split(",").map((c) => [c, r[c] ?? null])));
          return Promise.resolve({ data: page, error: null });
        },
      };
    },
  };
  return { client, calls };
}

/** Readings of `asset` at second `s` for each second of `seconds`, one per metric of `metrics`. */
function readings(asset: string, seconds: number[], metrics: string[]): Row[] {
  return seconds.flatMap((s) =>
    metrics.map((m) => ({
      time: `2026-09-01T10:00:${String(s).padStart(2, "0")}Z`,
      asset_id: asset,
      metric_name: m,
      val_double: s,
      val_string: null,
      val_bool: null,
    }))
  );
}

Deno.test("a raw page is telemetry_page() for the asset, newest first, keyset on time", async () => {
  const rows = [...readings("dev-a", [1, 2, 3, 4, 5], ["A", "B"]), ...readings("dev-b", [6], ["A"])];
  const { client, calls } = pageClient(rows, "time");
  const part = await loadTelemetry(client, "telemetry", "dev-a", 100, 3);

  assert.equal(part.rows.length, 10, "every row of the asset, none of another");
  assert.equal(part.truncated, false);
  assert.equal(part.newest, "2026-09-01T10:00:05Z");
  assert.equal(part.oldest, "2026-09-01T10:00:01Z");
  assert.equal(
    part.rows.map((r) => `${String(r.time).slice(17, 19)}${r.metric_name}`),
    ["05A", "05B", "04A", "04B", "03A", "03B", "02A", "02B", "01A", "01B"],
    "no row lost or repeated at an instant two pages share",
  );
  assert.equal(calls[0], { fn: "telemetry_page", args: { p_asset_id: "dev-a", p_limit: 3 }, select: RAW_COLUMNS.join(",") });
  // The boundary instant is read again, with room for the metric already emitted at it.
  assert.equal(calls[1].args, { p_asset_id: "dev-a", p_limit: 4, p_to: "2026-09-01T10:00:04Z" });
  assert.equal(calls.every((c) => c.fn === "telemetry_page"), true);
});

Deno.test("a raw page stops at the cap and says so", async () => {
  const { client } = pageClient(readings("dev-a", [1, 2, 3, 4, 5], ["A"]), "time");
  const part = await loadTelemetry(client, "telemetry", "dev-a", 3, 2);
  assert.equal(part.rows.map((r) => r.val_double), [5, 4, 3]);
  assert.equal(part.truncated, true);
  assert.equal(part.oldest, "2026-09-01T10:00:03Z");
});

Deno.test("an hourly page is telemetry_rollup_page() at 1h with the rollup's columns", async () => {
  const buckets = [1, 2, 3].map((h) => ({
    bucket: `2026-09-01T0${h}:00:00Z`,
    asset_id: "dev-a",
    metric_name: "A",
    avg_double: h,
    n_rows: 60,
  }));
  const { client, calls } = pageClient(buckets, "bucket");
  const part = await loadTelemetry(client, "telemetry_1h", "dev-a", 100, 2);
  assert.equal(part.rows.map((r) => r.bucket), ["2026-09-01T03:00:00Z", "2026-09-01T02:00:00Z", "2026-09-01T01:00:00Z"]);
  assert.equal(calls[0], {
    fn: "telemetry_rollup_page",
    args: { p_resolution: "1h", p_asset_id: "dev-a", p_limit: 2 },
    select: HOURLY_COLUMNS.join(","),
  });
  assert.equal(calls[1].args.p_to, "2026-09-01T02:00:00Z");
});
