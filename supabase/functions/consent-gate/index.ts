// The handler lives in gate.ts, so its test can import it without starting a listener.
import { handler } from "./gate.ts";

Deno.serve(handler);
