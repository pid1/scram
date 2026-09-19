import type { CloudflareApi } from "../cf/api.js";
import type { ActionResult, Target } from "../types.js";

/**
 * Apply and undo, one function per action kind.
 *
 * Every action is reversible from the data in `Target.undo`, which is written
 * to the trip record BEFORE anything is switched off. If scram trips and then
 * the account is unreachable for a week, the snapshot is still what restores
 * it. Nothing here deletes a Worker, its code, its bindings or its data.
 */

type Runner = (api: CloudflareApi, accountId: string, t: Target) => Promise<void>;

const APPLY: Record<string, Runner> = {
  async routes(api, _accountId, t) {
    const { zoneId, routeId } = t.apply as { zoneId: string; routeId: string };
    await api.delete(`/zones/${zoneId}/workers/routes/${routeId}`);
  },

  async custom_domains(api, accountId, t) {
    const { domainId } = t.apply as { domainId: string };
    await api.delete(`/accounts/${accountId}/workers/domains/${domainId}`);
  },

  async crons(api, accountId, t) {
    const { script } = t.apply as { script: string };
    await api.put(`/accounts/${accountId}/workers/scripts/${script}/schedules`, []);
  },

  async subdomain(api, accountId, t) {
    const { script } = t.apply as { script: string };
    await api.post(`/accounts/${accountId}/workers/scripts/${script}/subdomain`, {
      enabled: false,
      previews_enabled: false,
    });
  },
};

const UNDO: Record<string, Runner> = {
  async routes(api, _accountId, t) {
    const { zoneId, pattern, script } = t.undo as {
      zoneId: string;
      pattern: string;
      script: string;
    };
    await api.post(`/zones/${zoneId}/workers/routes`, { pattern, script });
  },

  async custom_domains(api, accountId, t) {
    const { zoneId, hostname, service, environment } = t.undo as {
      zoneId: string;
      hostname: string;
      service: string;
      environment: string;
    };
    await api.put(`/accounts/${accountId}/workers/domains`, {
      zone_id: zoneId,
      hostname,
      service,
      environment: environment || "production",
    });
  },

  async crons(api, accountId, t) {
    const { script, crons } = t.undo as { script: string; crons: string[] };
    await api.put(
      `/accounts/${accountId}/workers/scripts/${script}/schedules`,
      crons.map((cron) => ({ cron })),
    );
  },

  async subdomain(api, accountId, t) {
    const { script, previews_enabled } = t.undo as {
      script: string;
      previews_enabled: boolean;
    };
    await api.post(`/accounts/${accountId}/workers/scripts/${script}/subdomain`, {
      enabled: true,
      previews_enabled: previews_enabled ?? false,
    });
  },
};

async function run(
  table: Record<string, Runner>,
  api: CloudflareApi,
  accountId: string,
  targets: readonly Target[],
  dryRun: boolean,
): Promise<ActionResult[]> {
  const results: ActionResult[] = [];

  for (const target of targets) {
    const runner = table[target.kind];
    if (!runner) {
      results.push({ target, status: "skipped", error: `no handler for ${target.kind}` });
      continue;
    }
    if (dryRun) {
      results.push({ target, status: "skipped", error: "dry run" });
      continue;
    }
    try {
      await runner(api, accountId, target);
      results.push({ target, status: "ok" });
    } catch (e) {
      // One failed target must not abandon the rest. A partial shutdown still
      // cuts spend; stopping at the first error would not.
      results.push({ target, status: "failed", error: String((e as Error)?.message ?? e) });
    }
  }

  return results;
}

export function applyAll(
  api: CloudflareApi,
  accountId: string,
  targets: readonly Target[],
  dryRun: boolean,
): Promise<ActionResult[]> {
  return run(APPLY, api, accountId, targets, dryRun);
}

export function undoAll(
  api: CloudflareApi,
  accountId: string,
  targets: readonly Target[],
  dryRun: boolean,
): Promise<ActionResult[]> {
  return run(UNDO, api, accountId, targets, dryRun);
}
