// The handler lives in logs.ts, so its test can import it without starting a listener.
import { handler } from "./logs.ts";

Deno.serve(handler);
