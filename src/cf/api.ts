const BASE = "https://api.cloudflare.com/client/v4";

export interface CfResponse<T> {
  success: boolean;
  result: T;
  errors: { code: number; message: string }[];
}

export class CloudflareApi {
  constructor(private readonly token: string) {}

  async request<T>(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<T> {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    let json: CfResponse<T>;
    try {
      json = (await res.json()) as CfResponse<T>;
    } catch {
      throw new Error(`${method} ${path}: HTTP ${res.status}, unparseable body`);
    }

    if (!json.success) {
      const detail = json.errors?.map((e) => `${e.code} ${e.message}`).join("; ");
      throw new Error(`${method} ${path}: ${detail || `HTTP ${res.status}`}`);
    }
    return json.result;
  }

  get<T>(path: string) {
    return this.request<T>("GET", path);
  }
  put<T>(path: string, body: unknown) {
    return this.request<T>("PUT", path, body);
  }
  post<T>(path: string, body: unknown) {
    return this.request<T>("POST", path, body);
  }
  delete<T>(path: string) {
    return this.request<T>("DELETE", path);
  }
}
