const ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";

export interface GraphQLError {
  message: string;
  path?: (string | number)[];
}

export class GraphQLClient {
  constructor(
    private readonly token: string,
    private readonly accountTag: string,
  ) {}

  /**
   * Run one query against the account scope.
   *
   * `body` is spliced inside `account(filter: {accountTag: ...}) { ... }`, so
   * collectors write only the dataset selections they care about.
   */
  async account<T>(body: string): Promise<T> {
    const query = `query ScramUsage {
      viewer {
        accounts(filter: { accountTag: "${this.accountTag}" }) {
          ${body}
        }
      }
    }`;

    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query }),
    });

    if (!res.ok) {
      throw new Error(`GraphQL HTTP ${res.status}: ${await safeText(res)}`);
    }

    const json = (await res.json()) as {
      data?: { viewer?: { accounts?: T[] } };
      errors?: GraphQLError[];
    };

    if (json.errors?.length) {
      throw new Error(`GraphQL: ${json.errors.map((e) => e.message).join("; ")}`);
    }

    const account = json.data?.viewer?.accounts?.[0];
    if (!account) throw new Error("GraphQL returned no account; check the token's account scope");
    return account;
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return "<unreadable>";
  }
}

/** Inclusive date range covering the billing cycle so far, as YYYY-MM-DD. */
export interface Range {
  readonly since: Date;
  readonly until: Date;
  readonly sinceDate: string;
  readonly untilDate: string;
  readonly sinceIso: string;
  readonly untilIso: string;
  /** Whole days from cycle start to now, minimum 1. Used for GB-month maths. */
  readonly days: number;
}

export function range(since: Date, until: Date): Range {
  const days = Math.max(
    1,
    Math.ceil((until.getTime() - since.getTime()) / 86_400_000),
  );
  return {
    since,
    until,
    sinceDate: since.toISOString().slice(0, 10),
    untilDate: until.toISOString().slice(0, 10),
    sinceIso: since.toISOString(),
    untilIso: until.toISOString(),
    days,
  };
}
