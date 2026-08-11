import { StatusMessage } from './types';

interface AdminSettingsTabProps {
  systemPrompt: string;
  hasCustomSystemPrompt: boolean;
  onSystemPromptChange: (value: string) => void;
  systemPromptMessage: StatusMessage | null;
  isSavingSystemPrompt: boolean;
  onSaveSystemPrompt: () => void;
  koboFormUrl: string;
  onKoboFormUrlChange: (value: string) => void;
  koboFormUid: string;
  koboMessage: StatusMessage | null;
  isSavingKobo: boolean;
  onSaveKobo: () => void;
  readOnly?: boolean;
}

export default function AdminSettingsTab({
  systemPrompt,
  hasCustomSystemPrompt,
  onSystemPromptChange,
  systemPromptMessage,
  isSavingSystemPrompt,
  onSaveSystemPrompt,
  koboFormUrl,
  onKoboFormUrlChange,
  koboFormUid,
  koboMessage,
  isSavingKobo,
  onSaveKobo,
  readOnly = false,
}: AdminSettingsTabProps) {
  return (
    <div>
      <div className="admin-section">
        <h2>
          System Prompt{' '}
          {hasCustomSystemPrompt
            ? <span className="admin-badge admin-badge-success">(Custom)</span>
            : <span className="admin-badge admin-badge-muted">(Default)</span>}
        </h2>
        <p className="admin-section-desc">
          {hasCustomSystemPrompt
            ? 'You are using a custom system prompt. Edit below to update it.'
            : 'Currently using the default system prompt. Edit below to create a custom one.'}
        </p>
        <textarea
          value={systemPrompt}
          onChange={(e) => onSystemPromptChange(e.target.value)}
          placeholder="Enter custom system prompt..."
          rows={10}
          className="admin-textarea"
          readOnly={readOnly}
          style={readOnly ? { opacity: 0.8 } : undefined}
        />

        <div className="admin-mt">
          {systemPromptMessage && (
            <div className={`admin-msg ${systemPromptMessage.type === 'success' ? 'admin-msg-success' : 'admin-msg-error'}`}>
              {systemPromptMessage.text}
            </div>
          )}

          {!readOnly && (
            <button
              onClick={onSaveSystemPrompt}
              disabled={isSavingSystemPrompt}
              className="admin-btn admin-btn-primary"
            >
              {isSavingSystemPrompt ? 'Saving...' : 'Save System Prompt'}
            </button>
          )}
        </div>
      </div>

      <div className="admin-section">
        <h2>KoboToolbox Form</h2>
        <p className="admin-section-desc">
          Enter the Enketo submission URL for this project's KoboToolbox form.
          The Form UID is resolved automatically by the deployment tools.
        </p>

        <div className="admin-field">
          <label className="admin-label">Enketo Submission URL</label>
          <input
            type="text"
            value={koboFormUrl}
            onChange={(e) => onKoboFormUrlChange(e.target.value)}
            placeholder="https://ee.kobotoolbox.org/single/..."
            className="admin-input"
            readOnly={readOnly}
          />
          <p className="admin-hint">
            Find this in KoboToolbox under Form &gt; Collect Data &gt; Online-Only (once).
          </p>
        </div>

        {koboFormUid && (
          <div className="admin-field">
            <label className="admin-label">Form UID</label>
            <div className="admin-uid-box">
              <a
                href={`https://kf.kobotoolbox.org/#/forms/${koboFormUid}/summary`}
                target="_blank"
                rel="noopener noreferrer"
              >
                {koboFormUid} &#8599;
              </a>
            </div>
            <p className="admin-hint">
              Set automatically by deployment tools. Used for API operations (data export, form updates).
            </p>
          </div>
        )}

        <div className="admin-mt">
          {koboMessage && (
            <div className={`admin-msg ${koboMessage.type === 'success' ? 'admin-msg-success' : 'admin-msg-error'}`}>
              {koboMessage.text}
            </div>
          )}

          {!readOnly && (
            <button
              onClick={onSaveKobo}
              disabled={isSavingKobo}
              className="admin-btn admin-btn-primary"
            >
              {isSavingKobo ? 'Saving...' : 'Save Kobo Form'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
