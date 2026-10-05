// The /admin route both entries serve (main.tsx and talk-main.tsx): the
// app-relative path, and the admin login or dashboard behind it.

import { useEffect, useState, lazy, Suspense } from 'react';
import { api, apiFetch } from './api-base';
import AdminLogin from './components/AdminLogin';

const AdminDashboard = lazy(() => import('./components/AdminDashboard'));

// Strip Vite base path to get the app-relative path
function getAppPath(): string {
  const basePath = (import.meta.env.BASE_URL || '/').replace(/\/$/, '');
  const full = window.location.pathname;
  return basePath && full.startsWith(basePath)
    ? full.slice(basePath.length) || '/'
    : full;
}

/** The path below the build's base path, kept current across history navigation. */
export function useAppPath(): string {
  const [currentPath, setCurrentPath] = useState(getAppPath());

  // Listen for navigation changes
  useEffect(() => {
    const handlePopState = () => {
      setCurrentPath(getAppPath());
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  return currentPath;
}

export const ADMIN_PATH = '/admin';

/** The admin page: checks for an existing session, then the dashboard or the login. */
export function AdminRoute() {
  const [adminToken, setAdminToken] = useState<string | null>(null);
  const [adminScope, setAdminScope] = useState<'global' | 'project'>('global');
  const [isCheckingAuth, setIsCheckingAuth] = useState(true);

  // Check for existing session on mount
  useEffect(() => {
    const verifySession = async () => {
      try {
        const response = await apiFetch(api('/api/admin/verify'), {
          credentials: 'include',
        });
        if (response.ok) {
          const data = await response.json();
          setAdminToken('session');
          setAdminScope(data.scope === 'project' ? 'project' : 'global');
        }
      } catch (err) {
        // Session invalid or error, stay logged out
        console.error('Session verification failed:', err);
      } finally {
        setIsCheckingAuth(false);
      }
    };

    verifySession();
  }, []);

  // Handle admin login
  const handleAdminLogin = (token: string, scope?: string) => {
    setAdminToken(token);
    setAdminScope(scope === 'project' ? 'project' : 'global');
  };

  // Handle admin logout
  const handleAdminLogout = async () => {
    try {
      await apiFetch(api('/api/admin/logout'), {
        method: 'POST',
        credentials: 'include',
      });
    } catch (err) {
      console.error('Logout error:', err);
    }
    setAdminToken(null);
  };

  // Show loading state while checking auth
  if (isCheckingAuth) {
    return (
      <div className="admin-page">
        <div style={{ color: 'var(--text-secondary)', fontSize: '1.2em' }}>Loading...</div>
      </div>
    );
  }

  if (adminToken) {
    return (
      <Suspense fallback={
        <div className="admin-page">
          <div style={{ color: 'var(--text-secondary)', fontSize: '1.2em' }}>Loading...</div>
        </div>
      }>
        <AdminDashboard token={adminToken} onLogout={handleAdminLogout} readOnly={adminScope === 'project'} />
      </Suspense>
    );
  }
  return <AdminLogin onLogin={handleAdminLogin} />;
}
