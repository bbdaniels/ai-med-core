// The whole-page screens both pages show before the chat: the course access
// gate, the refusal of a link to an unknown document, and the loading screen.

import AccessGate from '../components/AccessGate';
import type { Translate } from './useLanguages';

export function CourseAccessGate({ t, onUnlocked }: { t: Translate; onUnlocked: () => void }) {
  return (
    <AccessGate
      title={t('welcome', 'title') || 'Course access'}
      hint={t('welcome', 'accessHint')
        || 'Enter the access code from the course Canvas page.'}
      onUnlocked={onUnlocked}
    />
  );
}

/** A requireKnownVignette link that names no vignette this deployment holds. */
export function UnknownDocumentScreen({ t }: { t: Translate }) {
  return (
    <div className="welcome-screen">
      <div className="welcome-content access-gate" role="alert">
        <h1>{t('welcome', 'title') || t('chat', 'headerTitle')}</h1>
        <p className="access-gate-hint">{t('chat', 'unknownVignette') || 'Nothing is available at this link.'}</p>
      </div>
    </div>
  );
}

export function LoadingScreen() {
  return (
    <div className="welcome-screen">
      <div className="welcome-content" style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '200px' }}>
        <p>Loading...</p>
      </div>
    </div>
  );
}
