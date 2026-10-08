// The handler lives in admission.ts, so its test can import it without starting a listener.
import { handler } from "./admission.ts";

Deno.serve(handler);
