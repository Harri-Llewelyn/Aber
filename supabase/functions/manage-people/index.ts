// The handler lives in people.ts, so its test can import it without starting a listener.
import { handler } from "./people.ts";

Deno.serve(handler);
