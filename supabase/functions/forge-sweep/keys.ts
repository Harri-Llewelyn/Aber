/** The columns of a gateway row the deploy-key reconciliation reads. */
export interface KeyedGateway {
  is_archived: boolean;
  deployment: string;
}

/**
 * Whether a gateway's appliance may hold a deploy key: a Remote gateway that is not archived. An
 * archived gateway is decommissioned, a gateway of another type has no appliance of Aber's, and one
 * whose row is gone has neither, so any key left for them must open nothing. The repository stays.
 */
export function holdsDeployKey(gateway: KeyedGateway | undefined): boolean {
  return gateway !== undefined && !gateway.is_archived && gateway.deployment === "remote";
}
