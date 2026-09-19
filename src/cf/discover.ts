import type { CloudflareApi } from "./api.js";
import type { ActionKind, Config, Target } from "../types.js";

/**
 * Everything scram could switch off, read live from the account.
 *
 * Nothing here is configured. Every Worker, every route on every zone, every
 * custom domain and every cron trigger is discovered on each run, so a project
 * deployed after scram was set up is covered the moment it exists -- there is
 * no list to remember to update.
 */

interface Script {
  id: string;
}
interface Zone {
  id: string;
  name: string;
}
interface Route {
  id: string;
  pattern: string;
  script?: string;
}
interface Domain {
  id: string;
  hostname: string;
  service: string;
  zone_id: string;
  zone_name: string;
  environment: string;
}
interface Schedule {
  cron: string;
}

export interface Inventory {
  readonly scripts: readonly string[];
  readonly zones: readonly Zone[];
  readonly targets: readonly Target[];
  /** Discovery steps that failed, so partial inventories are never silent. */
  readonly failures: Readonly<Record<string, string>>;
}

export async function discover(
  api: CloudflareApi,
  accountId: string,
  config: Config,
): Promise<Inventory> {
  const failures: Record<string, string> = {};
  const targets: Target[] = [];

  const note = (step: string, e: unknown) => {
    failures[step] = String((e as Error)?.message ?? e);
  };

  const scripts = await api
    .get<Script[]>(`/accounts/${accountId}/workers/scripts`)
    .then((s) => s.map((x) => x.id))
    .catch((e) => {
      note("scripts", e);
      return [] as string[];
    });

  const zones = await api
    .get<Zone[]>(`/zones?account.id=${accountId}&per_page=50`)
    .catch((e) => {
      note("zones", e);
      return [] as Zone[];
    });

  const want = (k: ActionKind) => config.actions.includes(k);
  // A protected script is left entirely alone, including its crons.
  const eligible = (script: string) => !config.protect.has(script);

  if (want("routes")) {
    for (const zone of zones) {
      try {
        const routes = await api.get<Route[]>(`/zones/${zone.id}/workers/routes`);
        for (const route of routes) {
          if (!route.script || !eligible(route.script)) continue;
          targets.push({
            kind: "routes",
            script: route.script,
            label: route.pattern,
            undo: { zoneId: zone.id, pattern: route.pattern, script: route.script },
            apply: { zoneId: zone.id, routeId: route.id },
          });
        }
      } catch (e) {
        note(`routes:${zone.name}`, e);
      }
    }
  }

  if (want("custom_domains")) {
    try {
      const domains = await api.get<Domain[]>(`/accounts/${accountId}/workers/domains`);
      for (const d of domains) {
        if (!eligible(d.service)) continue;
        targets.push({
          kind: "custom_domains",
          script: d.service,
          label: d.hostname,
          undo: {
            zoneId: d.zone_id,
            hostname: d.hostname,
            service: d.service,
            environment: d.environment,
          },
          apply: { domainId: d.id },
        });
      }
    } catch (e) {
      note("custom_domains", e);
    }
  }

  if (want("crons")) {
    for (const script of scripts) {
      if (!eligible(script)) continue;
      try {
        const res = await api.get<{ schedules: Schedule[] }>(
          `/accounts/${accountId}/workers/scripts/${script}/schedules`,
        );
        const crons = res.schedules?.map((s) => s.cron) ?? [];
        if (crons.length === 0) continue;
        targets.push({
          kind: "crons",
          script,
          label: crons.join(", "),
          undo: { script, crons },
          apply: { script },
        });
      } catch (e) {
        note(`crons:${script}`, e);
      }
    }
  }

  if (want("subdomain")) {
    for (const script of scripts) {
      if (!eligible(script)) continue;
      try {
        const res = await api.get<{ enabled: boolean; previews_enabled?: boolean }>(
          `/accounts/${accountId}/workers/scripts/${script}/subdomain`,
        );
        if (!res.enabled) continue;
        targets.push({
          kind: "subdomain",
          script,
          label: `${script}.workers.dev`,
          undo: { script, previews_enabled: res.previews_enabled ?? false },
          apply: { script },
        });
      } catch (e) {
        // A script that has never had a workers.dev subdomain 404s here. That
        // is the common case, not a fault, so it is not recorded as one.
        const msg = String((e as Error)?.message ?? e);
        if (!/10007|404|not found/i.test(msg)) note(`subdomain:${script}`, e);
      }
    }
  }

  return { scripts, zones, targets, failures };
}
