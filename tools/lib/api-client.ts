/**
 * Admin API client for programmatic content management.
 * Used by tools/ scripts to push cases, config, and assignments to running deployments.
 *
 * Every admin request is retried while the deployment restarts (502, 503, 504,
 * a refused or reset connection; tools/lib/retry-fetch.ts), and on nothing
 * else. That is safe because each call below is safe to repeat: the reads, the
 * login (it only issues a token), the saves (each sets a value, the vignette
 * save by key), the deletes (by key, id or path), the private-store upload
 * (an atomic overwrite of one path) and the bulk assignment add (the server
 * skips pairs it already has). The one exception is addAssignment, where a
 * repeat of an applied request is refused as a duplicate; it is sent once.
 */
import { fetchWithRetry, type RetryOptions } from './retry-fetch.js';

export interface ApiClientConfig {
  baseUrl: string;
  passphrase: string;
  /** Project name sent as X-Project header for multi-tenant routing */
  project?: string;
  /** Waits between retries of a request the restarting deployment did not answer. Default: retry-fetch's. */
  retryDelaysMs?: number[];
}

export interface Vignette {
  id?: number;
  key: string;
  content: string;
}

/** One logged chat turn from the durable qa_log table (GET /api/admin/qa-log). */
export interface QaLogRow {
  id: number;
  session_token: string | null;
  vignette_key: string | null;
  language: string | null;
  question: string;
  answer: string;
  /** ISO-8601 UTC */
  created_at: string;
}

export interface QaLogPage {
  project: string;
  days: number | null;
  since: string | null;
  until: string | null;
  limit: number;
  offset: number;
  total: number;
  returned: number;
  hasMore: boolean;
  rows: QaLogRow[];
}

export class AdminApiClient {
  private baseUrl: string;
  private token: string | null = null;
  private passphrase: string;
  private project: string | undefined;
  private retry: RetryOptions;

  constructor(config: ApiClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.passphrase = config.passphrase;
    this.project = config.project;
    this.retry = config.retryDelaysMs ? { delaysMs: config.retryDelaysMs } : {};
  }

  private projectHeaders(): Record<string, string> {
    return this.project ? { 'X-Project': this.project } : {};
  }

  private async authenticate(): Promise<void> {
    const res = await fetchWithRetry(`${this.baseUrl}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.projectHeaders() },
      body: JSON.stringify({ passphrase: this.passphrase }),
    }, this.retry);

    if (!res.ok) {
      throw new Error(`Authentication failed: ${res.status} ${res.statusText}`);
    }

    const data = await res.json();
    this.token = data.token;
  }

  /**
   * One admin request. `repeatable: false` sends it exactly once per
   * authentication, for a call whose repeat the server would refuse.
   */
  private async request(path: string, options: RequestInit = {}, repeatable = true): Promise<any> {
    if (!this.token) {
      await this.authenticate();
    }

    const send = () => {
      const init: RequestInit = {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.token}`,
          ...this.projectHeaders(),
          ...options.headers,
        },
      };
      return repeatable ? fetchWithRetry(`${this.baseUrl}${path}`, init, this.retry) : fetch(`${this.baseUrl}${path}`, init);
    };

    const res = await send();

    // Retry once on auth failure
    if (res.status === 401) {
      await this.authenticate();
      const retry = await send();
      if (!retry.ok) {
        throw new Error(`API request failed: ${retry.status} ${retry.statusText}`);
      }
      return retry.json();
    }

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`API request failed: ${res.status} ${res.statusText} - ${body}`);
    }

    return res.json();
  }

  // --- Content endpoints ---

  async getContent(): Promise<{
    systemPrompt: string;
    vignettes: Vignette[];
    koboFormUrl: string;
  }> {
    return this.request('/api/admin/content');
  }

  async saveSystemPrompt(systemPrompt: string): Promise<void> {
    await this.request('/api/admin/system-prompt', {
      method: 'POST',
      body: JSON.stringify({ systemPrompt }),
    });
  }

  async saveKoboUrl(koboFormUrl: string): Promise<void> {
    await this.request('/api/admin/kobo-url', {
      method: 'POST',
      body: JSON.stringify({ koboFormUrl }),
    });
  }

  async saveKoboUid(koboFormUid: string): Promise<void> {
    await this.request('/api/admin/kobo-uid', {
      method: 'POST',
      body: JSON.stringify({ koboFormUid }),
    });
  }

  async saveVignette(key: string, content: string, id?: number): Promise<void> {
    await this.request('/api/admin/vignette', {
      method: 'POST',
      body: JSON.stringify({ id, key, content }),
    });
  }

  async deleteVignette(key: string): Promise<void> {
    await this.request(`/api/admin/vignette/${encodeURIComponent(key)}`, {
      method: 'DELETE',
    });
  }

  async saveLanguages(config: object): Promise<void> {
    await this.request('/api/admin/languages', {
      method: 'POST',
      body: JSON.stringify(config),
    });
  }

  async saveCaseTemplate(caseTemplate: string): Promise<void> {
    await this.request('/api/admin/case-template', {
      method: 'POST',
      body: JSON.stringify({ caseTemplate }),
    });
  }

  // --- Private content store (files kept out of git; see tools/lib/private-files.ts) ---

  /** What the deployment's private store holds for this project, with hashes. */
  async listPrivateContent(): Promise<{
    configured: boolean;
    files: Array<{ path: string; bytes: number; sha256: string }>;
  }> {
    return this.request('/api/admin/private-content');
  }

  async putPrivateContent(relPath: string, body: Uint8Array): Promise<void> {
    await this.request(`/api/admin/private-content/${encodeURI(relPath)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: body as unknown as BodyInit,   // a Node Buffer is a valid fetch body
    });
  }

  async deletePrivateContent(relPath: string): Promise<void> {
    await this.request(`/api/admin/private-content/${encodeURI(relPath)}`, {
      method: 'DELETE',
    });
  }

  // --- Assignment endpoints ---

  async getAssignments(): Promise<{
    assignments: Array<{ id: number; uid: string; vignette_id: number; vignette_key: string; created_at?: string }>;
  }> {
    return this.request('/api/admin/vignette-assignments');
  }

  async addAssignment(uid: string, vignetteKey: string): Promise<void> {
    await this.request('/api/admin/vignette-assignments', {
      method: 'POST',
      body: JSON.stringify({ uid, vignetteKey }),
    }, false);
  }

  async deleteAssignment(id: number): Promise<void> {
    await this.request(`/api/admin/vignette-assignments/${id}`, {
      method: 'DELETE',
    });
  }

  async bulkAddAssignments(
    assignments: Array<{ uid: string; vignetteKey: string }>
  ): Promise<any> {
    return this.request('/api/admin/vignette-assignments/bulk', {
      method: 'POST',
      body: JSON.stringify({ assignments: assignments.map(a => ({ uid: a.uid, case: a.vignetteKey })) }),
    });
  }

  // --- Usage ---

  /** The deployment's token_usage summary for this project over the last `days` days. */
  async getTokenUsage(days = 1): Promise<{
    totals: { prompt_tokens: number; completion_tokens: number; estimated_cost: number };
    [k: string]: unknown;
  }> {
    return this.request(`/api/admin/token-usage?days=${days}`);
  }

  // --- Conversation log endpoints ---

  async getQaLog(params: {
    days?: number;
    since?: string;
    until?: string;
    limit?: number;
    offset?: number;
  }): Promise<QaLogPage> {
    const qs = new URLSearchParams();
    if (params.since) qs.set('since', params.since);
    else if (params.days !== undefined) qs.set('days', String(params.days));
    if (params.until) qs.set('until', params.until);
    if (params.limit !== undefined) qs.set('limit', String(params.limit));
    if (params.offset !== undefined) qs.set('offset', String(params.offset));
    return this.request(`/api/admin/qa-log?${qs.toString()}`);
  }

  // --- Public endpoints ---

  async healthCheck(): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/health`, {
      headers: this.projectHeaders(),
    });
    if (!res.ok) throw new Error(`Health check failed: ${res.status}`);
    return res.json();
  }

  async getConfig(): Promise<any> {
    const res = await fetch(`${this.baseUrl}/api/config`, {
      headers: this.projectHeaders(),
    });
    if (!res.ok) throw new Error(`Config fetch failed: ${res.status}`);
    return res.json();
  }
}
