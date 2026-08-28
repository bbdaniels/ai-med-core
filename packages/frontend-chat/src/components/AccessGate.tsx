import { useState } from 'react';
import { api, apiFetch, setAccessToken } from '../api-base';

interface AccessGateProps {
  title: string;
  /** One line saying where the code comes from. */
  hint: string;
  onUnlocked: () => void;
}

/**
 * Shared-code gate for a project that sets `requireAccessCode`.
 *
 * The code is checked on the server, which mints a signed token the app then
 * sends on every request. Nothing here decides access on its own — a gate the
 * browser could satisfy by itself would be decoration.
 *
 * This is a speed bump, not authentication: a cohort shares one code and any
 * student can pass it along. It exists so a course tool is not open to the whole
 * internet and is not a free LLM endpoint for anyone who finds the URL.
 */
export function AccessGate({ title, hint, onUnlocked }: AccessGateProps) {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!code.trim() || checking) return;
    setChecking(true);
    setError(null);
    try {
      const res = await apiFetch(api('/api/access'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.error || 'That code is not right.');
        return;
      }
      setAccessToken(data.token ?? null);
      onUnlocked();
    } catch {
      setError('Could not reach the server. Check your connection and try again.');
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="welcome-screen">
      <div className="welcome-content access-gate">
        <h1>{title}</h1>
        <p className="access-gate-hint">{hint}</p>
        <form onSubmit={submit} className="access-gate-form">
          <input
            type="text"
            value={code}
            onChange={e => setCode(e.target.value)}
            placeholder="Course access code"
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            aria-label="Course access code"
            disabled={checking}
          />
          <button type="submit" disabled={checking || !code.trim()}>
            {checking ? 'Checking…' : 'Enter'}
          </button>
        </form>
        {error && <p className="access-gate-error" role="alert">{error}</p>}
      </div>
    </div>
  );
}

export default AccessGate;
