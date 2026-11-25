import { fileAtCommit, type ForgeConfig, PLATFORM_POINTER_PATH } from "./forge.ts";
import { findPlatformTag, isOlderRelease, type WaitingBump } from "./platformBump.ts";
import type { serviceRoleClient } from "./serviceClient.ts";

/**
 * What a gateway's row says of the platform bump that waits for approval: the release proposed and its
 * pull request (0327), for the drawer. The forge holds the proposal, so the row is a copy of it.
 * forge-sweep writes it and clears it on each pass, and forge-events clears it when the merge arrives.
 * Nothing else writes the two columns, and neither change is audited.
 */

/** The row, as the sweep reads it. */
export interface BumpRow {
  sparkplug_id: string;
  forge_bump_tag: string | null;
  forge_bump_number: number | null;
}

type Admin = ReturnType<typeof serviceRoleClient>;

/**
 * The row made to say what waits, or that nothing does: one a person closed and one `main` has caught
 * up with are both nothing. A row that says so already is left.
 */
export async function recordBump(admin: Admin, gateway: BumpRow, waiting: WaitingBump | null): Promise<void> {
  const wanted = { forge_bump_tag: waiting?.tag ?? null, forge_bump_number: waiting?.number ?? null };
  if (gateway.forge_bump_tag === wanted.forge_bump_tag && gateway.forge_bump_number === wanted.forge_bump_number) return;
  const { error } = await admin.from("gateways").update(wanted).eq("sparkplug_id", gateway.sparkplug_id);
  if (error) throw new Error(`could not record the platform bump that waits: ${error.message}`);
}

/**
 * Clear what the row says waits, once `main` at `commit` no longer names an older release. Any other
 * push to `main` leaves it. The update names the tag it clears, so one recorded meanwhile stays. Never
 * throws: the push is recorded by now, and the next pass reads the proposal itself.
 */
export async function clearMergedBump(
  cfg: ForgeConfig,
  admin: Admin,
  repository: string,
  sparkplugId: string,
  commit: string,
): Promise<void> {
  try {
    const row = await admin.from("gateways").select("forge_bump_tag").eq("sparkplug_id", sparkplugId).maybeSingle();
    if (row.error) throw new Error(row.error.message);
    const waits = row.data?.forge_bump_tag;
    if (!waits) return;
    const file = await fileAtCommit(cfg, { name: repository }, PLATFORM_POINTER_PATH, commit);
    const found = file && findPlatformTag(new TextDecoder().decode(file.bytes));
    if (!found || "reason" in found || isOlderRelease(found.tag, waits)) return;
    const { error } = await admin.from("gateways").update({ forge_bump_tag: null, forge_bump_number: null })
      .eq("sparkplug_id", sparkplugId).eq("forge_bump_tag", waits);
    if (error) throw new Error(error.message);
  } catch (err) {
    console.warn(
      `forge-events: could not tell whether a platform bump still waits on '${repository}' ` +
        `(${err instanceof Error ? err.message : err}); the next sweep does`,
    );
  }
}
