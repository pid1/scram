import { route } from "./router.js";
import { check } from "./scram/check.js";
import { readConfig } from "./config.js";
import { notify } from "./notify.js";
import type { Env } from "./types.js";

export default {
  fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return route(req, env, ctx);
  },

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // A throw here is retried by the runtime but is otherwise invisible, and a
    // kill switch that has silently stopped checking is worse than no kill
    // switch at all -- it produces false confidence. So failures are caught
    // and pushed out through the same channel as a trip.
    ctx.waitUntil(
      check(env).catch(async (e) => {
        const message = String((e as Error)?.message ?? e);
        console.error(`[scram] check failed: ${message}`);
        try {
          await notify(readConfig(env), {
            kind: "error",
            title: "scram check failed",
            message: `The scheduled check threw and no estimate was recorded: ${message}`,
          });
        } catch {
          // readConfig itself can throw on bad vars; the console line above is
          // then the only signal, and Workers Logs will have it.
        }
      }),
    );
  },
} satisfies ExportedHandler<Env>;
