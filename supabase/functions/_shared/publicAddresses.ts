/**
 * The two addresses an appliance dials, and why each is refused rather than defaulted: a wrong
 * value produces an appliance that enrols and then connects to nothing. gateway-bundle checks the
 * platform URL before minting, enroll-gateway checks the broker host before touching the token,
 * and the readiness probe on gateway-bundle reports both so the dashboard can say so before a
 * remote gateway is created. One predicate per variable, shared, so the probe cannot disagree
 * with the refusal.
 */

export interface AddressState {
  /** The variable's name, as an operator would find it in .env or the chart. */
  variable: string;
  /** The configured value, trailing slashes stripped. Empty when unset. */
  value: string;
  /** Why an appliance could not use it, or null when it can. */
  problem: string | null;
}

const IN_STACK_URL = /supabase-kong|127\.0\.0\.1|localhost|::1/;
const IN_STACK_HOSTS = new Set(["mosquitto", "localhost", "127.0.0.1", "::1", "supabase-kong"]);

/** SUPABASE_PUBLIC_URL: where the appliance redeems its token and fetches from then on. */
export function platformPublicUrl(): AddressState {
  const value = (Deno.env.get("SUPABASE_PUBLIC_URL") || "").replace(/\/+$/, "");
  let problem: string | null = null;
  if (!value) problem = "unset";
  else if (IN_STACK_URL.test(value)) problem = `'${value}' resolves only inside the stack`;
  return { variable: "SUPABASE_PUBLIC_URL", value, problem };
}

/** MQTT_PUBLIC_HOST: what the appliance's flow dials, and a name in the broker certificate. */
export function brokerPublicHost(): AddressState {
  const value = (Deno.env.get("MQTT_PUBLIC_HOST") || "").trim();
  let problem: string | null = null;
  if (!value) problem = "unset";
  else if (IN_STACK_HOSTS.has(value)) problem = `'${value}' resolves only inside the stack`;
  return { variable: "MQTT_PUBLIC_HOST", value, problem };
}
