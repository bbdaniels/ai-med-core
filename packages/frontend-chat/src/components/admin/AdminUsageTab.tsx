interface UsageSummary {
  totals: { prompt_tokens: number; completion_tokens: number; estimated_cost: number };
  byModel: Array<{ model: string; prompt_tokens: number; completion_tokens: number; estimated_cost: number; call_count: number }>;
  byProject: Array<{ project: string; prompt_tokens: number; completion_tokens: number; estimated_cost: number; call_count: number }>;
  byDay: Array<{ day: string; prompt_tokens: number; completion_tokens: number; estimated_cost: number; call_count: number }>;
}

interface SessionStats {
  totals: { sessions: number; submissions: number; transcripts: number; messages: number };
  byDay: Array<{ day: string; sessions: number; submissions: number; messages: number }>;
  byVignette: Array<{ vignette_key: string; sessions: number; submissions: number; avg_messages: number }>;
}

interface AdminUsageTabProps {
  usage: UsageSummary | null;
  sessionStats: SessionStats | null;
  isLoading: boolean;
  days: number;
  readOnly?: boolean;
  onDaysChange: (days: number) => void;
  onRefresh: () => void;
}

export default function AdminUsageTab({
  usage,
  sessionStats,
  isLoading,
  days,
  readOnly = false,
  onDaysChange,
  onRefresh,
}: AdminUsageTabProps) {
  const fmt = (n: number) => `$${n.toFixed(4)}`;
  const fmtTokens = (n: number) => n.toLocaleString();
  const pct = (a: number, b: number) => b > 0 ? `${Math.round((a / b) * 100)}%` : '--';

  return (
    <div>
      {/* Session Engagement */}
      <div className="admin-section">
        <h2>Engagement</h2>
        <p className="admin-section-desc">
          Student chat sessions, form submissions, and completion rates.
        </p>

        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' }}>
          <label className="admin-label" style={{ margin: 0 }}>Period:</label>
          <select
            value={days}
            onChange={(e) => onDaysChange(Number(e.target.value))}
            className="admin-input"
            style={{ width: 'auto' }}
          >
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
          </select>
          <button
            onClick={onRefresh}
            disabled={isLoading}
            className="admin-btn admin-btn-secondary"
          >
            {isLoading ? 'Loading...' : 'Refresh'}
          </button>
        </div>

        {isLoading && !sessionStats && <p>Loading engagement data...</p>}

        {sessionStats && (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '12px', marginBottom: '24px' }}>
              <div className="admin-stat-card">
                <div className="admin-stat-value">{fmtTokens(sessionStats.totals.sessions)}</div>
                <div className="admin-stat-label">Sessions</div>
              </div>
              <div className="admin-stat-card">
                <div className="admin-stat-value">{fmtTokens(sessionStats.totals.submissions)}</div>
                <div className="admin-stat-label">Submissions</div>
              </div>
              <div className="admin-stat-card">
                <div className="admin-stat-value">{pct(sessionStats.totals.submissions, sessionStats.totals.sessions)}</div>
                <div className="admin-stat-label">Completion Rate</div>
              </div>
              <div className="admin-stat-card">
                <div className="admin-stat-value">{fmtTokens(sessionStats.totals.messages)}</div>
                <div className="admin-stat-label">Total Messages</div>
              </div>
            </div>

            {/* By Vignette */}
            {sessionStats.byVignette.length > 0 && (
              <div style={{ marginBottom: '24px' }}>
                <h3 style={{ fontSize: '14px', fontWeight: 600, marginBottom: '8px' }}>By Vignette</h3>
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>Vignette</th>
                      <th style={{ textAlign: 'right' }}>Sessions</th>
                      <th style={{ textAlign: 'right' }}>Submissions</th>
                      <th style={{ textAlign: 'right' }}>Completion</th>
                      <th style={{ textAlign: 'right' }}>Avg Messages</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sessionStats.byVignette.map((row) => (
                      <tr key={row.vignette_key}>
                        <td><code>{row.vignette_key}</code></td>
                        <td style={{ textAlign: 'right' }}>{fmtTokens(row.sessions)}</td>
                        <td style={{ textAlign: 'right' }}>{fmtTokens(row.submissions)}</td>
                        <td style={{ textAlign: 'right' }}>{pct(row.submissions, row.sessions)}</td>
                        <td style={{ textAlign: 'right' }}>{row.avg_messages}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Daily Engagement */}
            {sessionStats.byDay.length > 0 && (
              <div style={{ marginBottom: '24px' }}>
                <h3 style={{ fontSize: '14px', fontWeight: 600, marginBottom: '8px' }}>Daily Engagement</h3>
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th style={{ textAlign: 'right' }}>Sessions</th>
                      <th style={{ textAlign: 'right' }}>Submissions</th>
                      <th style={{ textAlign: 'right' }}>Messages</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sessionStats.byDay.map((row) => (
                      <tr key={row.day}>
                        <td>{row.day}</td>
                        <td style={{ textAlign: 'right' }}>{fmtTokens(row.sessions)}</td>
                        <td style={{ textAlign: 'right' }}>{fmtTokens(row.submissions)}</td>
                        <td style={{ textAlign: 'right' }}>{fmtTokens(row.messages)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {sessionStats.totals.sessions === 0 && (
              <p className="admin-section-desc">No engagement data recorded yet.</p>
            )}
          </>
        )}
      </div>

      {/* API Usage (token costs) */}
      <div className="admin-section">
        <h2>API Usage</h2>
        <p className="admin-section-desc">
          OpenAI API token usage and estimated costs.
        </p>

        {isLoading && !usage && <p>Loading usage data...</p>}

        {usage && (
          <>
            {/* Totals */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '12px', marginBottom: '24px' }}>
              <div className="admin-stat-card">
                <div className="admin-stat-value">{fmt(usage.totals.estimated_cost)}</div>
                <div className="admin-stat-label">Estimated Cost</div>
              </div>
              <div className="admin-stat-card">
                <div className="admin-stat-value">{fmtTokens(usage.totals.prompt_tokens)}</div>
                <div className="admin-stat-label">Prompt Tokens</div>
              </div>
              <div className="admin-stat-card">
                <div className="admin-stat-value">{fmtTokens(usage.totals.completion_tokens)}</div>
                <div className="admin-stat-label">Completion Tokens</div>
              </div>
            </div>

            {/* By Model */}
            {usage.byModel.length > 0 && (
              <div style={{ marginBottom: '24px' }}>
                <h3 style={{ fontSize: '14px', fontWeight: 600, marginBottom: '8px' }}>By Model</h3>
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>Model</th>
                      <th style={{ textAlign: 'right' }}>Calls</th>
                      <th style={{ textAlign: 'right' }}>Prompt</th>
                      <th style={{ textAlign: 'right' }}>Completion</th>
                      <th style={{ textAlign: 'right' }}>Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {usage.byModel.map((row) => (
                      <tr key={row.model}>
                        <td><code>{row.model}</code></td>
                        <td style={{ textAlign: 'right' }}>{fmtTokens(row.call_count)}</td>
                        <td style={{ textAlign: 'right' }}>{fmtTokens(row.prompt_tokens)}</td>
                        <td style={{ textAlign: 'right' }}>{fmtTokens(row.completion_tokens)}</td>
                        <td style={{ textAlign: 'right' }}>{fmt(row.estimated_cost)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* By Day */}
            {usage.byDay.length > 0 && (
              <div style={{ marginBottom: '24px' }}>
                <h3 style={{ fontSize: '14px', fontWeight: 600, marginBottom: '8px' }}>Daily API Usage</h3>
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th style={{ textAlign: 'right' }}>Calls</th>
                      <th style={{ textAlign: 'right' }}>Tokens</th>
                      <th style={{ textAlign: 'right' }}>Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {usage.byDay.map((row) => (
                      <tr key={row.day}>
                        <td>{row.day}</td>
                        <td style={{ textAlign: 'right' }}>{fmtTokens(row.call_count)}</td>
                        <td style={{ textAlign: 'right' }}>{fmtTokens(row.prompt_tokens + row.completion_tokens)}</td>
                        <td style={{ textAlign: 'right' }}>{fmt(row.estimated_cost)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {usage.byModel.length === 0 && (
              <p className="admin-section-desc">No API usage data recorded yet.</p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
