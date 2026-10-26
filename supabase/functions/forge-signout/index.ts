// The handler lives in signout.ts, so its test can import it without starting a listener.
import { handler } from "./signout.ts";

Deno.serve(handler);
