import { ChangeEvent, RefObject, useEffect, useRef } from 'react';
import { BulkCsvPreview, StatusMessage, Vignette, VignetteAssignment } from './types';

interface AdminAssignmentsTabProps {
  assignments: VignetteAssignment[];
  assignmentsMessage: StatusMessage | null;
  isLoadingAssignments: boolean;
  newAssignmentUid: string;
  newAssignmentVignetteKey: string;
  onAssignmentUidChange: (value: string) => void;
  onAssignmentVignetteChange: (value: string) => void;
  onAddAssignment: () => void;
  isAddingAssignment: boolean;
  vignettes: Vignette[];
  deletingAssignmentId: number | null;
  onDeleteAssignment: (id: number) => void;
  bulkFileInputRef: RefObject<HTMLInputElement>;
  bulkImportMessage: StatusMessage | null;
  bulkPreview: BulkCsvPreview | null;
  bulkFileName: string;
  onBulkFileChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onBulkImport: () => void;
  isImportingBulk: boolean;
  bulkImportLimit: number;
  selectedAssignmentIds: Set<number>;
  selectedAssignmentCount: number;
  isAllAssignmentsSelected: boolean;
  onToggleAssignmentSelection: (id: number, checked: boolean) => void;
  onToggleAllAssignmentsSelection: (checked: boolean) => void;
  onBulkDeleteSelected: () => void;
  isBulkDeleting: boolean;
}

export default function AdminAssignmentsTab({
  assignments,
  assignmentsMessage,
  isLoadingAssignments,
  newAssignmentUid,
  newAssignmentVignetteKey,
  onAssignmentUidChange,
  onAssignmentVignetteChange,
  onAddAssignment,
  isAddingAssignment,
  vignettes,
  deletingAssignmentId,
  onDeleteAssignment,
  bulkFileInputRef,
  bulkImportMessage,
  bulkPreview,
  bulkFileName,
  onBulkFileChange,
  onBulkImport,
  isImportingBulk,
  bulkImportLimit,
  selectedAssignmentIds,
  selectedAssignmentCount,
  isAllAssignmentsSelected,
  onToggleAssignmentSelection,
  onToggleAllAssignmentsSelection,
  onBulkDeleteSelected,
  isBulkDeleting,
}: AdminAssignmentsTabProps) {
  const selectAllCheckboxRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (selectAllCheckboxRef.current) {
      selectAllCheckboxRef.current.indeterminate =
        selectedAssignmentCount > 0 && !isAllAssignmentsSelected;
    }
  }, [selectedAssignmentCount, isAllAssignmentsSelected]);

  return (
    <div>
      <div className="admin-section">
        <h2>User Assignments</h2>
        <p className="admin-section-desc">
          Assign specific vignettes to users. When a user accesses the app with their uid in the URL
          (e.g., <code className="admin-code">?values=d[uid]=user123</code>),
          they will only see vignettes assigned to them. If no assignments exist, they see all vignettes.
        </p>
      </div>

      {assignmentsMessage && (
        <div className={`admin-msg ${assignmentsMessage.type === 'success' ? 'admin-msg-success' : 'admin-msg-error'}`}>
          {assignmentsMessage.text}
        </div>
      )}

      <div className="admin-form-row">
        <div className="admin-field">
          <label className="admin-label">User ID</label>
          <input
            type="text"
            value={newAssignmentUid}
            onChange={(e) => onAssignmentUidChange(e.target.value)}
            placeholder="e.g., user123"
            className="admin-input"
          />
        </div>
        <div className="admin-field">
          <label className="admin-label">Vignette</label>
          <select
            value={newAssignmentVignetteKey}
            onChange={(e) => onAssignmentVignetteChange(e.target.value)}
            className="admin-select"
          >
            <option value="">Select a vignette...</option>
            {vignettes.map((v) => (
              <option key={v.key} value={v.key}>{v.key}</option>
            ))}
          </select>
        </div>
        <button
          onClick={onAddAssignment}
          disabled={isAddingAssignment}
          className="admin-btn admin-btn-success"
        >
          {isAddingAssignment ? 'Adding...' : '+ Add Assignment'}
        </button>
      </div>

      <div className="admin-bulk-zone">
        <div className="admin-bulk-header">
          <div style={{ flex: 1, minWidth: '220px' }}>
            <h3>Bulk Import Assignments</h3>
            <p>
              Upload a CSV or TSV file with <code className="admin-code">uid</code> and <code className="admin-code">case</code> columns (max {bulkImportLimit} rows).
              Duplicate rows and blanks are ignored automatically.
            </p>
          </div>
          <label className="admin-file-label">
            Choose CSV
            <input
              ref={bulkFileInputRef}
              type="file"
              accept=".csv,.tsv,text/csv,text/tab-separated-values"
              onChange={onBulkFileChange}
            />
          </label>
        </div>

        {bulkFileName && !bulkPreview && (
          <p className="admin-hint admin-mt">Loaded file: {bulkFileName}</p>
        )}

        {bulkImportMessage && (
          <div className={`admin-msg admin-mt ${bulkImportMessage.type === 'success' ? 'admin-msg-success' : 'admin-msg-error'}`}>
            {bulkImportMessage.text}
          </div>
        )}

        {bulkPreview && (
          <div className="admin-bulk-preview">
            <p>
              File: <strong>{bulkFileName || 'Untitled.csv'}</strong> &mdash; Ready to import {bulkPreview.assignments.length} assignment{bulkPreview.assignments.length === 1 ? '' : 's'}
              {bulkPreview.duplicates ? ` \u00b7 ${bulkPreview.duplicates} duplicates ignored` : ''}
              {bulkPreview.blankRows ? ` \u00b7 ${bulkPreview.blankRows} empty rows skipped` : ''}
            </p>
            <div className="admin-bulk-preview-table">
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>uid</th>
                    <th>case</th>
                  </tr>
                </thead>
                <tbody>
                  {bulkPreview.assignments.slice(0, 5).map((row, idx) => (
                    <tr key={`${row.uid}-${row.case}-${idx}`}>
                      <td>{row.uid}</td>
                      <td>{row.case}</td>
                    </tr>
                  ))}
                  {bulkPreview.assignments.length > 5 && (
                    <tr>
                      <td colSpan={2} className="admin-italic">
                        ...and {bulkPreview.assignments.length - 5} more rows
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <button
          onClick={onBulkImport}
          disabled={!bulkPreview || bulkPreview.assignments.length === 0 || isImportingBulk}
          className="admin-btn admin-btn-success admin-mt"
        >
          {isImportingBulk ? 'Importing...' : 'Import Assignments'}
        </button>
      </div>

      {isLoadingAssignments ? (
        <p className="admin-italic">Loading assignments...</p>
      ) : assignments.length === 0 ? (
        <p className="admin-italic">No user assignments yet. Add one above to restrict which vignettes specific users can see.</p>
      ) : (
        <div className="admin-table-wrap">
          {selectedAssignmentCount > 0 && (
            <div className="admin-selection-bar">
              <span>
                {selectedAssignmentCount} assignment{selectedAssignmentCount === 1 ? '' : 's'} selected
              </span>
              <button
                onClick={onBulkDeleteSelected}
                disabled={isBulkDeleting}
                className="admin-btn admin-btn-danger admin-btn-sm"
              >
                {isBulkDeleting ? 'Deleting...' : 'Delete selected'}
              </button>
            </div>
          )}
          <table className="admin-table">
            <thead>
              <tr>
                <th className="narrow center">
                  <input
                    ref={selectAllCheckboxRef}
                    type="checkbox"
                    checked={isAllAssignmentsSelected}
                    onChange={(event) => onToggleAllAssignmentsSelection(event.target.checked)}
                    disabled={isBulkDeleting}
                    aria-label="Select all assignments"
                  />
                </th>
                <th>User ID</th>
                <th>Vignette</th>
                <th className="action-col">Action</th>
              </tr>
            </thead>
            <tbody>
              {assignments.map((assignment) => (
                <tr key={assignment.id}>
                  <td className="narrow center">
                    <input
                      type="checkbox"
                      checked={selectedAssignmentIds.has(assignment.id)}
                      onChange={(event) => onToggleAssignmentSelection(assignment.id, event.target.checked)}
                      disabled={isBulkDeleting}
                      aria-label={`Select assignment for user ${assignment.uid}`}
                    />
                  </td>
                  <td>{assignment.uid}</td>
                  <td className={assignment.vignette_key ? '' : 'muted'}>
                    {assignment.vignette_key || <em>(deleted vignette)</em>}
                  </td>
                  <td className="action-col">
                    <button
                      onClick={() => onDeleteAssignment(assignment.id)}
                      disabled={deletingAssignmentId === assignment.id || isBulkDeleting}
                      className="admin-btn admin-btn-danger admin-btn-sm"
                    >
                      {deletingAssignmentId === assignment.id ? 'Removing...' : 'Remove'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
