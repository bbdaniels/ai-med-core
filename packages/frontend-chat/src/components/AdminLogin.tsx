import { useState } from 'react';
import { api, apiFetch } from '../api-base';
import './admin/admin.css';

interface AdminLoginProps {
  onLogin: (token: string, scope?: string) => void;
}

export default function AdminLogin({ onLogin }: AdminLoginProps) {
  const [passphrase, setPassphrase] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!passphrase.trim()) {
      setError('Please enter a passphrase');
      return;
    }

    setIsLoading(true);

    try {
      const response = await apiFetch(api('/api/admin/login'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ passphrase }),
      });

      const data = await response.json();

      if (response.ok && data.success) {
        onLogin(data.token, data.scope);
      } else {
        setError(data.error || 'Invalid passphrase');
      }
    } catch (err) {
      setError('Connection error. Please try again.');
      console.error('Login error:', err);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="admin-page">
      <div className="admin-card admin-card-sm">
        <h1 className="admin-login-title">Admin Access</h1>
        <p className="admin-login-desc">
          Enter the admin passphrase to manage system prompts and vignettes.
        </p>

        <form onSubmit={handleSubmit}>
          <div className="admin-field">
            <label htmlFor="passphrase" className="admin-label">
              Passphrase
            </label>
            <input
              id="passphrase"
              type="password"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              placeholder="Enter admin passphrase"
              disabled={isLoading}
              className="admin-input"
              autoFocus
            />
          </div>

          {error && (
            <div className="admin-msg admin-msg-error">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={isLoading}
            className="admin-btn admin-btn-primary"
            style={{ width: '100%', padding: '12px', fontSize: '16px' }}
          >
            {isLoading ? 'Verifying...' : 'Login'}
          </button>
        </form>
      </div>
    </div>
  );
}
