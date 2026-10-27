// The handler lives in subscriber.ts, so its test can import it without starting a listener.
import { handler } from "./subscriber.ts";

Deno.serve(handler);
