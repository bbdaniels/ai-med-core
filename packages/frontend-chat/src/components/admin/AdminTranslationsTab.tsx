import { ChangeEvent } from 'react';
import { StatusMessage } from './types';

interface AdminTranslationsTabProps {
  languagesJson: string;
  onLanguagesJsonChange: (value: string) => void;
  onLanguagesFileUpload: (event: ChangeEvent<HTMLInputElement>) => void;
  languagesMessage: StatusMessage | null;
  isSavingLanguages: boolean;
  onSaveLanguages: () => void;
  readOnly?: boolean;
}

export default function AdminTranslationsTab({
  languagesJson,
  onLanguagesJsonChange,
  onLanguagesFileUpload,
  languagesMessage,
  isSavingLanguages,
  onSaveLanguages,
  readOnly = false,
}: AdminTranslationsTabProps) {
  return (
    <div>
      <div className="admin-section">
        <h2>Translations (languages.json)</h2>
        <p className="admin-section-desc">
          Upload a languages.json file or edit the JSON directly to customize translations.
        </p>

        {!readOnly && (
          <div className="admin-mb">
            <label className="admin-file-label">
              Upload languages.json
              <input
                type="file"
                accept=".json"
                onChange={onLanguagesFileUpload}
              />
            </label>
          </div>
        )}

        <textarea
          value={languagesJson}
          onChange={(e) => onLanguagesJsonChange(e.target.value)}
          placeholder="Loading languages configuration..."
          rows={15}
          className="admin-textarea admin-textarea-mono"
          readOnly={readOnly}
          style={readOnly ? { opacity: 0.8 } : undefined}
        />

        <div className="admin-mt">
          {languagesMessage && (
            <div className={`admin-msg ${languagesMessage.type === 'success' ? 'admin-msg-success' : 'admin-msg-error'}`}>
              {languagesMessage.text}
            </div>
          )}

          {!readOnly && (
            <button
              onClick={onSaveLanguages}
              disabled={isSavingLanguages}
              className="admin-btn admin-btn-primary"
            >
              {isSavingLanguages ? 'Saving...' : 'Save Languages'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
