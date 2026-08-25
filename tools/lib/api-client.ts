/**
 * Admin API client for programmatic content management.
 * Used by tools/ scripts to push cases, config, and assignments to running deployments.
 */

export interface ApiClientConfig {
  baseUrl: string;
  passphrase: string;
  /** Project name sent as X-Project header for multi-tenant routing */
  project?: string;
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

  constructor(config: ApiClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.passphrase = config.passphrase;
    this.project = config.project;
  }

  private projectHeaders(): Record<string, string> {
    return this.project ? { 'X-Project': this.project } : {};
  }

  private async authenticate(): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.projectHeaders() },
      body: JSON.stringify({ passphrase: this.passphrase }),
    });

    if (!res.ok) {
      throw new Error(`Authentication failed: ${res.status} ${res.statusText}`);
    }

    const data = await res.json();
    this.token = data.token;
  }

  private async request(path: string, options: RequestInit = {}): Promise<any> {
    if (!this.token) {
      await this.authenticate();
    }

    const res = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.token}`,
        ...this.projectHeaders(),
        ...options.headers,
      },
    });

    // Retry once on auth failure
    if (res.status === 401) {
      await this.authenticate();
      const retry = await fetch(`${this.baseUrl}${path}`, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.token}`,
          ...this.projectHeaders(),
          ...options.headers,
        },
      });
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
    });
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
