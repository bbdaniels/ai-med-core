import { StatusMessage, Vignette } from './types';

interface AdminVignettesTabProps {
  vignettes: Vignette[];
  caseTemplate: string;
  vignetteMessages: Record<string, StatusMessage>;
  swappingOrder: boolean;
  deletingVignetteKey: string | null;
  savingVignetteIndex: number | null;
  message: StatusMessage | null;
  onVignetteKeyChange: (index: number, value: string) => void;
  onVignetteContentChange: (index: number, value: string) => void;
  onMoveVignette: (index: number, direction: 'up' | 'down') => void;
  onDeleteVignette: (index: number) => void;
  onSaveVignette: (index: number) => void;
  onAddVignette: () => void;
  editingIndex: number | null;
  editingDraft: Pick<Vignette, 'key' | 'content'> | null;
  hasUnsavedChanges: boolean;
  onStartEditing: (index: number) => void;
  onDiscardEditing: () => void;
  readOnly?: boolean;
}

export default function AdminVignettesTab({
  vignettes,
  caseTemplate,
  vignetteMessages,
  swappingOrder,
  deletingVignetteKey,
  savingVignetteIndex,
  message,
  onVignetteKeyChange,
  onVignetteContentChange,
  onMoveVignette,
  onDeleteVignette,
  onSaveVignette,
  onAddVignette,
  editingIndex,
  editingDraft,
  hasUnsavedChanges,
  onStartEditing,
  onDiscardEditing,
  readOnly = false,
}: AdminVignettesTabProps) {
  // Parse case template JSON
  let caseTitle = '';
  let vignetteTemplates: Record<string, string> = {};
  if (caseTemplate) {
    try {
      const parsed = JSON.parse(caseTemplate);
      caseTitle = parsed.title || parsed.name || caseTemplate;
      vignetteTemplates = parsed.vignetteTemplates || {};
    } catch {
      caseTitle = caseTemplate;
    }
  }

  // Group vignettes by template
  const templateNames = Object.keys(vignetteTemplates).length > 0
    ? [...new Set(Object.values(vignetteTemplates))]
    : [];

  const toLabel = (s: string) => s.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

  type VignetteWithIndex = { vignette: Vignette; globalIndex: number };
  const groups: { template: string; label: string; items: VignetteWithIndex[] }[] = [];

  if (templateNames.length > 0) {
    for (const tmpl of templateNames) {
      const items: VignetteWithIndex[] = [];
      vignettes.forEach((v, i) => {
        if (vignetteTemplates[v.key] === tmpl) {
          items.push({ vignette: v, globalIndex: i });
        }
      });
      if (items.length > 0) {
        groups.push({ template: tmpl, label: toLabel(tmpl), items });
      }
    }
    const mapped = new Set(Object.keys(vignetteTemplates));
    const unmapped: VignetteWithIndex[] = [];
    vignettes.forEach((v, i) => {
      if (!mapped.has(v.key)) {
        unmapped.push({ vignette: v, globalIndex: i });
      }
    });
    if (unmapped.length > 0) {
      groups.push({ template: '_other', label: 'Other', items: unmapped });
    }
  } else {
    groups.push({
      template: '_all',
      label: caseTitle || 'All Vignettes',
      items: vignettes.map((v, i) => ({ vignette: v, globalIndex: i })),
    });
  }

  const renderVignette = (vignette: Vignette, index: number) => {
    const isEditing = editingIndex === index;
    const currentDraft = isEditing && editingDraft ? editingDraft : null;
    const keyValue = currentDraft ? currentDraft.key : vignette.key;
    const contentValue = currentDraft ? currentDraft.content : vignette.content;
    const rowMessageKey = currentDraft?.key || vignette.key;
    const trimmedMessageKey = rowMessageKey.trim();
    const rowMessage =
      vignetteMessages[trimmedMessageKey] ||
      vignetteMessages[rowMessageKey] ||
      vignetteMessages[vignette.key];
    const actionsLocked = hasUnsavedChanges;

    return (
      <div key={index} className="admin-vignette-card">
        <div className="admin-vignette-header">
          <h3>
            Vignette {index + 1}
            {(() => {
              const match = vignette.content.match(/^#\s+(.+)/m);
              return match ? (
                <span className="admin-vignette-subtitle">
                  {' \u2014 '}{match[1]}
                </span>
              ) : null;
            })()}
          </h3>
          {!readOnly && (
            <div className="admin-vignette-actions">
              <button
                onClick={() => onMoveVignette(index, 'up')}
                disabled={index === 0 || swappingOrder || actionsLocked}
                title={actionsLocked ? 'Finish editing first' : index === 0 ? 'Already at the top' : 'Move up'}
                className="admin-btn admin-btn-primary admin-btn-sm"
              >
                &uarr;
              </button>
              <button
                onClick={() => onMoveVignette(index, 'down')}
                disabled={index === vignettes.length - 1 || swappingOrder || actionsLocked}
                title={actionsLocked ? 'Finish editing first' : index === vignettes.length - 1 ? 'Already at the bottom' : 'Move down'}
                className="admin-btn admin-btn-primary admin-btn-sm"
              >
                &darr;
              </button>
              <button
                onClick={() => onDeleteVignette(index)}
                disabled={vignettes.length <= 1 || deletingVignetteKey === vignette.key || actionsLocked}
                title={actionsLocked ? 'Finish editing first' : vignettes.length <= 1 ? 'Cannot delete last vignette' : `Delete "${vignette.key}"`}
                className="admin-btn admin-btn-danger admin-btn-sm"
              >
                {deletingVignetteKey === vignette.key ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          )}
        </div>

        <div className="admin-field">
          <label className="admin-label">Key</label>
          <input
            type="text"
            value={keyValue}
            onChange={(e) => onVignetteKeyChange(index, e.target.value)}
            placeholder="e.g., scenario_3"
            readOnly={!isEditing}
            className="admin-input"
          />
        </div>

        <div className="admin-field">
          <label className="admin-label">Case Scenario</label>
          <textarea
            value={contentValue}
            onChange={(e) => onVignetteContentChange(index, e.target.value)}
            placeholder="Paste the full case scenario here..."
            readOnly={!isEditing}
            rows={8}
            className="admin-textarea"
          />
        </div>

        {rowMessage && (
          <div className={`admin-msg ${rowMessage.type === 'success' ? 'admin-msg-success' : 'admin-msg-error'}`}>
            {rowMessage.text}
          </div>
        )}

        {!readOnly && (isEditing ? (
          <div className="admin-vignette-save-row">
            <button
              onClick={() => onSaveVignette(index)}
              disabled={savingVignetteIndex === index}
              className="admin-btn admin-btn-primary"
            >
              {savingVignetteIndex === index ? 'Saving...' : 'Save Changes'}
            </button>
            <button
              onClick={onDiscardEditing}
              disabled={savingVignetteIndex === index}
              className="admin-btn admin-btn-secondary"
            >
              Discard Changes
            </button>
          </div>
        ) : (
          <div className="admin-mt">
            <button
              onClick={() => onStartEditing(index)}
              disabled={hasUnsavedChanges}
              className="admin-btn admin-btn-primary"
            >
              Edit Vignette
            </button>
          </div>
        ))}
      </div>
    );
  };

  return (
    <div>
      <div className="admin-section">
        <h2>{caseTitle || 'Vignettes'}</h2>
        <p className="admin-section-desc">
          Edit the vignettes below. Each vignette has its own save button.
        </p>
      </div>

      {groups.map((group) => (
        <details key={group.template} open className="admin-details">
          <summary>
            <span style={{ fontSize: '0.8em', transition: 'transform 0.15s' }}>&#9660;</span>
            {group.label}
            {group.template !== '_all' && group.template !== '_other' && (
              <span className="admin-details-template">({group.template})</span>
            )}
            <span className="admin-details-count">
              {group.items.length} vignette{group.items.length !== 1 ? 's' : ''}
            </span>
          </summary>

          <div className="admin-details-body">
            {group.items.map(({ vignette, globalIndex }) =>
              renderVignette(vignette, globalIndex)
            )}
          </div>
        </details>
      ))}

      {!readOnly && (
        <button
          onClick={onAddVignette}
          disabled={hasUnsavedChanges}
          className="admin-btn admin-btn-success admin-mt"
        >
          + Add Vignette
        </button>
      )}

      {message && (
        <div className={`admin-msg admin-mt ${message.type === 'success' ? 'admin-msg-success' : 'admin-msg-error'}`}>
          {message.text}
        </div>
      )}
    </div>
  );
}
