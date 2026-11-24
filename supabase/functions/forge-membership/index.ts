// The handler lives in membership.ts, so its test can import it without starting a listener.
import { handler } from "./membership.ts";

Deno.serve(handler);
