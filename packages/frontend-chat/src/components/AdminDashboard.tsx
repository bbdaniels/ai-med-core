import { useState, useEffect, useRef } from 'react';
import { api, apiFetch, PROJECT } from '../api-base';
import AdminSettingsTab from './admin/AdminSettingsTab';
import AdminVignettesTab from './admin/AdminVignettesTab';
import AdminAssignmentsTab from './admin/AdminAssignmentsTab';
import AdminTranslationsTab from './admin/AdminTranslationsTab';
import AdminUsageTab from './admin/AdminUsageTab';
import { StatusMessage, Vignette, VignetteAssignment, BulkCsvPreview } from './admin/types';
import './admin/admin.css';

interface AdminDashboardProps {
  token: string;
  onLogout: () => void;
  readOnly?: boolean;
}

const BULK_IMPORT_ROW_LIMIT = 5000;

type AdminTab = 'settings' | 'vignettes' | 'assignments' | 'translations' | 'usage';

const TAB_OPTIONS: Array<{ id: AdminTab; label: string }> = [
  { id: 'settings', label: 'Settings' },
  { id: 'vignettes', label: 'Vignettes' },
  { id: 'assignments', label: 'Assignments' },
  { id: 'translations', label: 'Translations' },
  { id: 'usage', label: 'Usage' },
];

const normalizeHeaderName = (value: string): string =>
  value.trim().toLowerCase().replace(/[^a-z0-9]/g, '');

const splitDelimitedLine = (line: string, delimiter: string): string[] => {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  const normalizedLine = line.replace(/\r$/, '');

  for (let i = 0; i < normalizedLine.length; i += 1) {
    const char = normalizedLine[i];

    if (char === '"') {
      if (inQuotes && normalizedLine[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (!inQuotes && char === delimiter) {
      result.push(current);
      current = '';
      continue;
    }

    current += char;
  }

  result.push(current);
  return result;
};

const parseAssignmentsCsv = (text: string): BulkCsvPreview => {
  const lines = text.split(/\r?\n/);
  let headerLineIndex = -1;
  let delimiter = ',';
  let headerTokens: string[] | null = null;

  for (let i = 0; i < lines.length; i += 1) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    delimiter = rawLine.includes('\t') ? '\t' : ',';
    headerTokens = splitDelimitedLine(rawLine, delimiter).map((token) => token.trim());
    headerLineIndex = i;
    break;
  }

  if (!headerTokens) {
    throw new Error('CSV file must include a header row with "uid" and "case" columns.');
  }

  const normalizedHeaders = headerTokens.map(normalizeHeaderName);
  const uidIndex = normalizedHeaders.findIndex((name) => name === 'uid');
  const caseIndex = normalizedHeaders.findIndex((name) =>
    ['case', 'casekey', 'scenario', 'vignette', 'vignettekey'].includes(name)
  );

  if (uidIndex === -1 || caseIndex === -1) {
    throw new Error('CSV header must include "uid" and "case" columns.');
  }

  const assignments: Array<{ uid: string; case: string }> = [];
  const seenPairs = new Set<string>();
  let duplicates = 0;
  let blankRows = 0;
  const invalidRows: number[] = [];

  for (let i = headerLineIndex + 1; i < lines.length; i += 1) {
    const rawLine = lines[i];
    if (!rawLine) {
      blankRows += 1;
      continue;
    }
    const trimmed = rawLine.trim();
    if (!trimmed) {
      blankRows += 1;
      continue;
    }
    if (trimmed.startsWith('#')) {
      continue;
    }

    const columns = splitDelimitedLine(rawLine, delimiter);
    const uid = (columns[uidIndex] ?? '').trim();
    const caseValue = (columns[caseIndex] ?? '').trim();

    if (!uid && !caseValue) {
      blankRows += 1;
      continue;
    }

    if (!uid || !caseValue) {
      invalidRows.push(i + 1);
      continue;
    }

    const pairKey = `${uid}||${caseValue.toLowerCase()}`;
    if (seenPairs.has(pairKey)) {
      duplicates += 1;
      continue;
    }
    seenPairs.add(pairKey);
    assignments.push({ uid, case: caseValue });
  }

  if (invalidRows.length > 0) {
    throw new Error(`Rows ${invalidRows.join(', ')} are missing uid or case values.`);
  }

  return {
    assignments,
    totalRows: assignments.length + duplicates + blankRows,
    blankRows,
    duplicates,
  };
};
export default function AdminDashboard({ token, onLogout, readOnly = false }: AdminDashboardProps) {
  const [systemPrompt, setSystemPrompt] = useState('');
  const [vignettes, setVignettes] = useState<Vignette[]>([]);
  const [koboFormUrl, setKoboFormUrl] = useState('');
  const [koboFormUid, setKoboFormUid] = useState('');
  const [caseTemplate, setCaseTemplate] = useState('');
  const [hasCustomSystemPrompt, setHasCustomSystemPrompt] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [message, setMessage] = useState<StatusMessage | null>(null);
  const [languagesJson, setLanguagesJson] = useState('');
  const [isLoadingLanguages, setIsLoadingLanguages] = useState(false);
  const [languagesMessage, setLanguagesMessage] = useState<StatusMessage | null>(null);
  const [deletingVignetteKey, setDeletingVignetteKey] = useState<string | null>(null);
  const [swappingOrder, setSwappingOrder] = useState(false);
  const [selectedTab, setSelectedTab] = useState<AdminTab>('settings');

  // Vignette editing state
  const [editingVignetteIndex, setEditingVignetteIndex] = useState<number | null>(null);
  const [editingDraft, setEditingDraft] = useState<{ key: string; content: string } | null>(null);
  const [pendingNewIndex, setPendingNewIndex] = useState<number | null>(null);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  
  // Individual save states
  const [isSavingSystemPrompt, setIsSavingSystemPrompt] = useState(false);
  const [systemPromptMessage, setSystemPromptMessage] = useState<StatusMessage | null>(null);
  const [isSavingKoboUrl, setIsSavingKoboUrl] = useState(false);
  const [koboUrlMessage, setKoboUrlMessage] = useState<StatusMessage | null>(null);
  const [savingVignetteIndex, setSavingVignetteIndex] = useState<number | null>(null);
  const [vignetteMessages, setVignetteMessages] = useState<Record<string, StatusMessage>>({});
  
  // User assignments state
  const [assignments, setAssignments] = useState<VignetteAssignment[]>([]);
  const [isLoadingAssignments, setIsLoadingAssignments] = useState(false);
  const [assignmentsMessage, setAssignmentsMessage] = useState<StatusMessage | null>(null);
  const [newAssignmentUid, setNewAssignmentUid] = useState('');
  const [newAssignmentVignetteKey, setNewAssignmentVignetteKey] = useState('');
  const [isAddingAssignment, setIsAddingAssignment] = useState(false);
  const [deletingAssignmentId, setDeletingAssignmentId] = useState<number | null>(null);
  const [bulkPreview, setBulkPreview] = useState<BulkCsvPreview | null>(null);
  const [bulkFileName, setBulkFileName] = useState('');
  const [isImportingBulk, setIsImportingBulk] = useState(false);
  const bulkFileInputRef = useRef<HTMLInputElement | null>(null);
  const [bulkImportMessage, setBulkImportMessage] = useState<StatusMessage | null>(null);
  const [selectedAssignmentIds, setSelectedAssignmentIds] = useState<Set<number>>(new Set());
  const [isBulkDeleteModalOpen, setIsBulkDeleteModalOpen] = useState(false);
  const [isBulkDeleting, setIsBulkDeleting] = useState(false);

  // Usage tracking state
  const [usageData, setUsageData] = useState<any>(null);
  const [sessionStats, setSessionStats] = useState<any>(null);
  const [isLoadingUsage, setIsLoadingUsage] = useState(false);
  const [usageDays, setUsageDays] = useState(30);

  // Prevent accidental navigation with unsaved edits
  useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!hasUnsavedChanges) return;
      event.preventDefault();
      // Chrome requires returnValue to be set
      event.returnValue = '';
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, [hasUnsavedChanges]);

  // Load current content on mount
  useEffect(() => {
    loadContent();
    loadLanguages();
    loadAssignments();
  }, []);

  const resetEditingState = () => {
    setEditingVignetteIndex(null);
    setEditingDraft(null);
    setPendingNewIndex(null);
    setHasUnsavedChanges(false);
  };

  const handleSelectTab = (tab: AdminTab) => {
    if (hasUnsavedChanges && tab !== selectedTab) {
      window.alert('Please save or discard your vignette edits before leaving this page.');
      return;
    }
    setSelectedTab(tab);
    if (tab === 'usage' && !usageData && !isLoadingUsage) {
      loadUsage();
    }
  };

  const handleLogoutClick = () => {
    if (hasUnsavedChanges) {
      window.alert('Please save or discard your vignette edits before logging out.');
      return;
    }
    onLogout();
  };

  const loadContent = async () => {
    setIsLoading(true);
    try {
      const response = await apiFetch(api('/api/admin/content'), {
        credentials: 'include',
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });

      if (!response.ok) {
        throw new Error('Failed to load content');
      }

      const data = await response.json();
      
      // Set system prompt (this is the active one being used)
      setSystemPrompt(data.systemPrompt || '');
      setHasCustomSystemPrompt(data.hasCustomSystemPrompt || false);
      
      // Set Kobo form URL and UID
      setKoboFormUrl(data.koboFormUrl || '');
      setKoboFormUid(data.koboFormUid || '');
      setCaseTemplate(data.caseTemplate || '');

      // Store all vignettes for editing
      setVignettes(data.vignettes || []);
      resetEditingState();
    } catch (err) {
      console.error('Error loading content:', err);
      setMessage({ type: 'error', text: 'Failed to load content' });
    } finally {
      setIsLoading(false);
    }
  };

  const validateAndSanitize = (text: string): string => {
    // Trim whitespace
    let sanitized = text.trim();
    
    // Remove null bytes and other problematic characters
    sanitized = sanitized.replace(/\0/g, '');
    
    return sanitized;
  };

  const validateVignetteKey = (key: string): boolean => {
    // Only allow alphanumeric and underscores
    return /^[a-zA-Z0-9_]+$/.test(key);
  };

  const loadLanguages = async () => {
    setIsLoadingLanguages(true);
    try {
      const response = await apiFetch(api('/api/admin/languages'), {
        credentials: 'include',
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });

      if (!response.ok) {
        throw new Error('Failed to load languages');
      }

      const data = await response.json();
      setLanguagesJson(JSON.stringify(data, null, 2));
    } catch (err) {
      console.error('Error loading languages:', err);
      setLanguagesMessage({ type: 'error', text: 'Failed to load languages configuration' });
    } finally {
      setIsLoadingLanguages(false);
    }
  };

  const loadAssignments = async () => {
    setIsLoadingAssignments(true);
    try {
      const response = await apiFetch(api('/api/admin/vignette-assignments'), {
        credentials: 'include',
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });

      if (!response.ok) {
        throw new Error('Failed to load assignments');
      }

      const data = await response.json();
      setAssignments(data.assignments || []);
      setSelectedAssignmentIds(new Set());
      setIsBulkDeleteModalOpen(false);
    } catch (err) {
      console.error('Error loading assignments:', err);
      setAssignmentsMessage({ type: 'error', text: 'Failed to load user assignments' });
    } finally {
      setIsLoadingAssignments(false);
    }
  };

  const loadUsage = async (days?: number) => {
    setIsLoadingUsage(true);
    try {
      const d = days ?? usageDays;
      const [usageResp, statsResp] = await Promise.all([
        apiFetch(api(`/api/admin/token-usage?days=${d}`), {
          credentials: 'include',
          headers: { 'Authorization': `Bearer ${token}` },
        }),
        apiFetch(api(`/api/admin/session-stats?days=${d}`), {
          credentials: 'include',
          headers: { 'Authorization': `Bearer ${token}` },
        }),
      ]);
      if (usageResp.ok) setUsageData(await usageResp.json());
      if (statsResp.ok) setSessionStats(await statsResp.json());
    } catch (err) {
      console.error('Error loading usage:', err);
    } finally {
      setIsLoadingUsage(false);
    }
  };

  const handleAddAssignment = async () => {
    if (!newAssignmentUid.trim()) {
      setAssignmentsMessage({ type: 'error', text: 'Please enter a User ID' });
      return;
    }
    if (!newAssignmentVignetteKey) {
      setAssignmentsMessage({ type: 'error', text: 'Please select a vignette' });
      return;
    }

    setIsAddingAssignment(true);
    setAssignmentsMessage(null);

    try {
      const response = await apiFetch(api('/api/admin/vignette-assignments'), {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          uid: newAssignmentUid.trim(),
          vignetteKey: newAssignmentVignetteKey,
        }),
      });

      const data = await response.json();

      if (response.ok) {
        setAssignmentsMessage({ type: 'success', text: 'Assignment added successfully!' });
        setNewAssignmentUid('');
        setNewAssignmentVignetteKey('');
        loadAssignments();
      } else {
        setAssignmentsMessage({ type: 'error', text: data.error || 'Failed to add assignment' });
      }
    } catch (err) {
      console.error('Error adding assignment:', err);
      setAssignmentsMessage({ type: 'error', text: 'Connection error. Please try again.' });
    } finally {
      setIsAddingAssignment(false);
    }
  };

  const handleDeleteAssignment = async (id: number) => {
    setDeletingAssignmentId(id);
    setAssignmentsMessage(null);
    setSelectedAssignmentIds((prev) => {
      if (!prev.has(id)) {
        return prev;
      }
      const next = new Set(prev);
      next.delete(id);
      return next;
    });

    try {
      const response = await apiFetch(api(`/api/admin/vignette-assignments/${id}`), {
        method: 'DELETE',
        credentials: 'include',
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });

      if (response.ok) {
        setAssignmentsMessage({ type: 'success', text: 'Assignment removed successfully!' });
        loadAssignments();
      } else {
        const data = await response.json();
        setAssignmentsMessage({ type: 'error', text: data.error || 'Failed to delete assignment' });
      }
    } catch (err) {
      console.error('Error deleting assignment:', err);
      setAssignmentsMessage({ type: 'error', text: 'Connection error. Please try again.' });
    } finally {
      setDeletingAssignmentId(null);
    }
  };

  const handleBulkFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    setBulkFileName(file.name);
    setBulkImportMessage(null);
    setBulkPreview(null);

    try {
      const text = await file.text();
      const preview = parseAssignmentsCsv(text);

      if (preview.assignments.length === 0) {
        setBulkImportMessage({ type: 'error', text: 'No valid assignments found in the file.' });
        event.target.value = '';
        return;
      }

      if (preview.assignments.length > BULK_IMPORT_ROW_LIMIT) {
        setBulkImportMessage({
          type: 'error',
          text: `File contains ${preview.assignments.length} assignments. The maximum per import is ${BULK_IMPORT_ROW_LIMIT}.`,
        });
        event.target.value = '';
        return;
      }

      setBulkPreview(preview);
      const summaryParts = [
        `Loaded ${preview.assignments.length} assignment${preview.assignments.length === 1 ? '' : 's'}`,
      ];
      if (preview.duplicates) {
        summaryParts.push(`${preview.duplicates} duplicate row${preview.duplicates === 1 ? '' : 's'} ignored`);
      }
      if (preview.blankRows) {
        summaryParts.push(`${preview.blankRows} empty row${preview.blankRows === 1 ? '' : 's'} skipped`);
      }
      summaryParts.push('Click "Import Assignments" to continue.');
      setBulkImportMessage({ type: 'success', text: summaryParts.join(' · ') });
    } catch (error) {
      console.error('Error parsing bulk assignment CSV:', error);
      setBulkImportMessage({
        type: 'error',
        text: error instanceof Error ? error.message : 'Failed to parse CSV file.',
      });
    } finally {
      if (event.target) {
        event.target.value = '';
      }
    }
  };

  const handleBulkImport = async () => {
    if (!bulkPreview || bulkPreview.assignments.length === 0) {
      setBulkImportMessage({
        type: 'error',
        text: 'Upload a CSV with at least one assignment before importing.',
      });
      return;
    }

    setIsImportingBulk(true);
    setBulkImportMessage(null);

    try {
      const response = await apiFetch(api('/api/admin/vignette-assignments/bulk'), {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ assignments: bulkPreview.assignments }),
      });

      const data = await response.json();

      if (response.ok && data.summary) {
        const { created = 0, skippedExisting = 0, duplicatesInPayload = 0 } = data.summary;
        const parts = [`Imported ${created} assignment${created === 1 ? '' : 's'}`];
        if (skippedExisting) {
          parts.push(`${skippedExisting} already assigned`);
        }
        if (duplicatesInPayload) {
          parts.push(`${duplicatesInPayload} duplicate row${duplicatesInPayload === 1 ? '' : 's'} skipped`);
        }
        setBulkImportMessage({ type: 'success', text: parts.join(' · ') });
        setBulkPreview(null);
        setBulkFileName('');
        if (bulkFileInputRef.current) {
          bulkFileInputRef.current.value = '';
        }
        loadAssignments();
      } else if (data.error === 'missing_vignettes' && Array.isArray(data.missingVignetteKeys)) {
        setBulkImportMessage({
          type: 'error',
          text: `Import blocked — unknown cases: ${data.missingVignetteKeys.join(', ')}`,
        });
      } else if (data.error === 'invalid_rows' && Array.isArray(data.invalidRows)) {
        const rowNumbers = data.invalidRows.slice(0, 5).map((row: { row?: number }) => row.row).filter(Boolean);
        const suffix = data.invalidRows.length > 5 ? '...' : '';
        setBulkImportMessage({
          type: 'error',
          text: `Import blocked — ${rowNumbers.length ? `rows ${rowNumbers.join(', ')}${suffix}` : 'some rows'} missing uid/case values.`,
        });
      } else {
        setBulkImportMessage({
          type: 'error',
          text: data.error || 'Failed to import assignments.',
        });
      }
    } catch (error) {
      console.error('Error importing assignments:', error);
      setBulkImportMessage({ type: 'error', text: 'Connection error. Please try again.' });
    } finally {
      setIsImportingBulk(false);
    }
  };

  const handleToggleAssignmentSelection = (id: number, checked: boolean) => {
    setSelectedAssignmentIds((prev) => {
      const next = new Set(prev);
      if (checked) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  };

  const handleToggleAllAssignmentsSelection = (checked: boolean) => {
    if (checked) {
      setSelectedAssignmentIds(new Set(assignments.map((assignment) => assignment.id)));
    } else {
      setSelectedAssignmentIds(new Set());
    }
  };

  const handleOpenBulkDeleteModal = () => {
    if (selectedAssignmentIds.size === 0) {
      return;
    }
    setIsBulkDeleteModalOpen(true);
  };

  const handleCloseBulkDeleteModal = () => {
    if (isBulkDeleting) {
      return;
    }
    setIsBulkDeleteModalOpen(false);
  };

  const handleConfirmBulkDelete = async () => {
    if (selectedAssignmentIds.size === 0) {
      setIsBulkDeleteModalOpen(false);
      return;
    }

    setIsBulkDeleting(true);
    setAssignmentsMessage(null);

    try {
      const response = await apiFetch(api('/api/admin/vignette-assignments'), {
        method: 'DELETE',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ ids: Array.from(selectedAssignmentIds) }),
      });

      let data: any = null;
      try {
        data = await response.json();
      } catch {
        data = null;
      }

      if (response.ok) {
        const deletedCount = typeof data?.deleted === 'number'
          ? data.deleted
          : selectedAssignmentIds.size;
        const successMessage = deletedCount === 0
          ? 'No assignments were deleted.'
          : `Deleted ${deletedCount} assignment${deletedCount === 1 ? '' : 's'} successfully.`;
        setAssignmentsMessage({ type: 'success', text: successMessage });
        await loadAssignments();
      } else {
        setAssignmentsMessage({ type: 'error', text: data?.error || 'Failed to delete assignments' });
      }
    } catch (error) {
      console.error('Error deleting assignments:', error);
      setAssignmentsMessage({ type: 'error', text: 'Connection error. Please try again.' });
    } finally {
      setIsBulkDeleting(false);
      setIsBulkDeleteModalOpen(false);
      setSelectedAssignmentIds(new Set());
    }
  };

  const selectedAssignmentCount = selectedAssignmentIds.size;
  const isAllAssignmentsSelected = assignments.length > 0 && selectedAssignmentCount === assignments.length;

  const handleSaveLanguages = async () => {
    setLanguagesMessage(null);
    
    // Validate JSON
    let parsedJson;
    try {
      parsedJson = JSON.parse(languagesJson);
    } catch (e) {
      setLanguagesMessage({ type: 'error', text: 'Invalid JSON format' });
      return;
    }

    setIsLoadingLanguages(true);
    
    try {
      const response = await apiFetch(api('/api/admin/languages'), {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify(parsedJson),
      });

      const data = await response.json();

      if (response.ok) {
        setLanguagesMessage({ type: 'success', text: 'Languages updated! Refresh the page to see changes.' });
      } else {
        setLanguagesMessage({ type: 'error', text: data.details || data.error || 'Failed to save languages' });
      }
    } catch (err) {
      console.error('Save languages error:', err);
      setLanguagesMessage({ type: 'error', text: 'Connection error. Please try again.' });
    } finally {
      setIsLoadingLanguages(false);
    }
  };

  const handleLanguagesFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setLanguagesMessage(null);

    try {
      const text = await file.text();
      // Validate it's valid JSON
      JSON.parse(text);
      setLanguagesJson(text);
      setLanguagesMessage({ type: 'success', text: 'File loaded. Click "Save Languages" to apply.' });
    } catch (e) {
      setLanguagesMessage({ type: 'error', text: 'Invalid JSON file' });
    }
  };

  const handleSaveSystemPrompt = async () => {
    setSystemPromptMessage(null);
    
    const sanitizedSystemPrompt = validateAndSanitize(systemPrompt);
    
    if (!sanitizedSystemPrompt) {
      setSystemPromptMessage({ type: 'error', text: 'System prompt cannot be empty' });
      return;
    }
    
    setIsSavingSystemPrompt(true);
    
    try {
      const response = await apiFetch(api('/api/admin/system-prompt'), {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ systemPrompt: sanitizedSystemPrompt }),
      });
      
      const data = await response.json();
      
      if (response.ok) {
        setSystemPromptMessage({ type: 'success', text: 'System prompt saved successfully!' });
        setHasCustomSystemPrompt(true);
        // Update local state - no need to reload since we already have the value
        setSystemPrompt(sanitizedSystemPrompt);
      } else {
        setSystemPromptMessage({ type: 'error', text: data.details || data.error || 'Failed to save system prompt' });
      }
    } catch (err) {
      console.error('Save system prompt error:', err);
      setSystemPromptMessage({ type: 'error', text: 'Connection error. Please try again.' });
    } finally {
      setIsSavingSystemPrompt(false);
    }
  };

  const handleSaveKoboUrl = async () => {
    setKoboUrlMessage(null);
    
    const sanitizedKoboUrl = validateAndSanitize(koboFormUrl);
    
    // Validate URL if provided
    if (sanitizedKoboUrl) {
      try {
        const urlObj = new URL(sanitizedKoboUrl);
        if (urlObj.protocol !== 'https:') {
          setKoboUrlMessage({ type: 'error', text: 'Kobo form URL must use HTTPS' });
          return;
        }
      } catch (e) {
        setKoboUrlMessage({ type: 'error', text: 'Invalid Kobo form URL format' });
        return;
      }
    }
    
    setIsSavingKoboUrl(true);
    
    try {
      const response = await apiFetch(api('/api/admin/kobo-url'), {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ koboFormUrl: sanitizedKoboUrl }),
      });
      
      const data = await response.json();
      
      if (response.ok) {
        setKoboUrlMessage({ type: 'success', text: 'Kobo form URL saved successfully!' });
        // Update local state - no need to reload since we already have the value
        setKoboFormUrl(sanitizedKoboUrl);
      } else {
        setKoboUrlMessage({ type: 'error', text: data.details || data.error || 'Failed to save Kobo form URL' });
      }
    } catch (err) {
      console.error('Save Kobo URL error:', err);
      setKoboUrlMessage({ type: 'error', text: 'Connection error. Please try again.' });
    } finally {
      setIsSavingKoboUrl(false);
    }
  };


  const handleSaveVignette = async (index: number) => {
    const original = vignettes[index];
    const draft = editingVignetteIndex === index && editingDraft ? editingDraft : original;
    if (!original || !draft) {
      return;
    }

    const sanitizedKey = draft.key.trim();
    const sanitizedContent = validateAndSanitize(draft.content);
    const fallbackKey = original.key || `index_${index}`;

    // Clear previous message for this vignette
    setVignetteMessages((prev) => {
      const updated = { ...prev };
      delete updated[sanitizedKey];
      delete updated[fallbackKey];
      return updated;
    });
    
    // Validate
    if (!sanitizedKey) {
      setVignetteMessages((prev) => ({
        ...prev,
        [fallbackKey]: { type: 'error', text: 'Please provide a key' }
      }));
      return;
    }
    
    if (!validateVignetteKey(sanitizedKey)) {
      setVignetteMessages((prev) => ({
        ...prev,
        [sanitizedKey]: { type: 'error', text: 'Key must contain only letters, numbers, and underscores' }
      }));
      return;
    }
    
    if (!sanitizedContent) {
      setVignetteMessages((prev) => ({
        ...prev,
        [sanitizedKey]: { type: 'error', text: 'Content cannot be empty' }
      }));
      return;
    }
    
    // Check for duplicate keys (excluding current vignette)
    const duplicateKey = vignettes.find((v, i) => i !== index && v.key.trim() === sanitizedKey);
    if (duplicateKey) {
      setVignetteMessages((prev) => ({
        ...prev,
        [sanitizedKey]: { type: 'error', text: `Duplicate key "${sanitizedKey}" found. All vignette keys must be unique.` }
      }));
      return;
    }
    
    setSavingVignetteIndex(index);
    
    try {
      const response = await apiFetch(api('/api/admin/vignette'), {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          id: original.id,
          key: sanitizedKey,
          content: sanitizedContent,
        }),
      });
      
      const data = await response.json();
      
      if (response.ok) {
        setVignetteMessages((prev) => ({
          ...prev,
          [sanitizedKey]: { type: 'success', text: 'Vignette saved successfully!' }
        }));
        resetEditingState();
        
        // Reload vignettes and assignments from server to ensure consistency
        const contentResponse = await apiFetch(api('/api/admin/content'), {
          credentials: 'include',
          headers: { 'Authorization': `Bearer ${token}` },
        });
        if (contentResponse.ok) {
          const contentData = await contentResponse.json();
          setVignettes(contentData.vignettes || []);
        }
        loadAssignments();
      } else {
        setVignetteMessages((prev) => ({
          ...prev,
          [sanitizedKey]: { type: 'error', text: data.details || data.error || 'Failed to save vignette' }
        }));
      }
    } catch (err) {
      console.error('Save vignette error:', err);
      setVignetteMessages((prev) => ({
        ...prev,
        [sanitizedKey]: { type: 'error', text: 'Connection error. Please try again.' }
      }));
    } finally {
      setSavingVignetteIndex(null);
    }
  };

  const handleStartEditingVignette = (index: number) => {
    if (hasUnsavedChanges && editingVignetteIndex !== index) {
      window.alert('Please save or discard your current vignette edits before editing another vignette.');
      return;
    }

    const target = vignettes[index];
    if (!target) {
      return;
    }

    setEditingVignetteIndex(index);
    setEditingDraft({ key: target.key, content: target.content });
    setPendingNewIndex(null);
    setHasUnsavedChanges(true);
    setVignetteMessages((prev) => {
      const updated = { ...prev };
      delete updated[target.key];
      return updated;
    });
  };

  const handleDiscardVignetteChanges = () => {
    if (editingVignetteIndex === null) {
      return;
    }

    const draftKey = editingDraft?.key;

    if (pendingNewIndex !== null) {
      setVignettes((prev) => prev.filter((_, i) => i !== pendingNewIndex));
    }

    if (draftKey) {
      setVignetteMessages((prev) => {
        const updated = { ...prev };
        delete updated[draftKey];
        return updated;
      });
    }

    resetEditingState();
  };

  const handleVignetteKeyChange = (index: number, value: string) => {
    if (editingVignetteIndex !== index) {
      return;
    }
    setEditingDraft((prev) => (prev ? { ...prev, key: value } : prev));
  };

  const handleVignetteContentChange = (index: number, value: string) => {
    if (editingVignetteIndex !== index) {
      return;
    }
    setEditingDraft((prev) => (prev ? { ...prev, content: value } : prev));
  };

  const handleAddVignette = () => {
    if (hasUnsavedChanges) {
      window.alert('Please save or discard the current vignette before adding a new one.');
      return;
    }

    const newKey = `scenario_${vignettes.length + 1}`;
    const draft = { key: newKey, content: '' };
    const newIndex = vignettes.length;

    setVignettes([...vignettes, draft]);
    setEditingVignetteIndex(newIndex);
    setEditingDraft({ ...draft });
    setPendingNewIndex(newIndex);
    setHasUnsavedChanges(true);
    setMessage(null);
  };

  const handleDeleteVignette = async (index: number) => {
    if (hasUnsavedChanges) {
      window.alert('Please save or discard your current vignette edits before deleting another vignette.');
      return;
    }

    const vignette = vignettes[index];
    
    // Prevent deleting the last vignette
    if (vignettes.length <= 1) {
      setMessage({ type: 'error', text: 'Cannot delete the last vignette. At least one vignette is required.' });
      return;
    }

    // Confirm deletion
    if (!window.confirm(`Are you sure you want to delete vignette "${vignette.key}"? This action cannot be undone.`)) {
      return;
    }

    setDeletingVignetteKey(vignette.key);
    setMessage(null);

    try {
      // If the vignette has a key (not a new unsaved one), delete from server
      if (vignette.key.trim()) {
        const response = await apiFetch(api(`/api/admin/vignette/${encodeURIComponent(vignette.key)}`), {
          method: 'DELETE',
          credentials: 'include',
          headers: {
            'Authorization': `Bearer ${token}`,
          },
        });

        if (!response.ok) {
          const data = await response.json();
          throw new Error(data.error || 'Failed to delete vignette');
        }
      }

      // Remove from local state
      const newVignettes = vignettes.filter((_, i) => i !== index);
      setVignettes(newVignettes);
      setMessage({ type: 'success', text: `Vignette "${vignette.key}" deleted successfully.` });
    } catch (err) {
      console.error('Error deleting vignette:', err);
      setMessage({ type: 'error', text: err instanceof Error ? err.message : 'Failed to delete vignette' });
    } finally {
      setDeletingVignetteKey(null);
    }
  };

  const handleMoveVignette = async (index: number, direction: 'up' | 'down') => {
    if (hasUnsavedChanges) {
      window.alert('Please save or discard your current vignette edits before reordering.');
      return;
    }

    const targetIndex = direction === 'up' ? index - 1 : index + 1;
    
    // Bounds check
    if (targetIndex < 0 || targetIndex >= vignettes.length) return;
    
    const vignette1 = vignettes[index];
    const vignette2 = vignettes[targetIndex];
    
    // Both vignettes must have been saved (have keys)
    if (!vignette1.key.trim() || !vignette2.key.trim()) {
      setMessage({ type: 'error', text: 'Please save the vignettes before reordering.' });
      return;
    }
    
    setSwappingOrder(true);
    setMessage(null);
    
    try {
      const response = await apiFetch(api('/api/admin/vignettes/swap'), {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          key1: vignette1.key,
          key2: vignette2.key,
        }),
      });
      
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to reorder vignettes');
      }
      
      // Update local state - swap the vignettes in the array
      const newVignettes = [...vignettes];
      [newVignettes[index], newVignettes[targetIndex]] = [newVignettes[targetIndex], newVignettes[index]];
      setVignettes(newVignettes);
    } catch (err) {
      console.error('Error reordering vignettes:', err);
      setMessage({ type: 'error', text: err instanceof Error ? err.message : 'Failed to reorder vignettes' });
    } finally {
      setSwappingOrder(false);
    }
  };


  if (isLoading) {
    return (
      <div className="admin-page">
        <div style={{ color: 'var(--text-secondary)', fontSize: '1.2em' }}>Loading...</div>
      </div>
    );
  }

  return (
    <div className="admin-page-top">
      <div className="admin-card admin-card-lg">
        <div className="admin-header">
          <h1>Admin Dashboard{PROJECT ? ` — ${PROJECT.replace(/[-_]/g, ' ')}` : ''}</h1>
          <button
            onClick={handleLogoutClick}
            disabled={hasUnsavedChanges}
            className="admin-btn admin-btn-logout"
          >
            Logout
          </button>
        </div>

        <div className="admin-tabs">
          {TAB_OPTIONS.map((tab) => {
            const isActive = selectedTab === tab.id;
            const isDisabled = hasUnsavedChanges && !isActive;
            return (
              <button
                key={tab.id}
                onClick={() => handleSelectTab(tab.id)}
                disabled={isDisabled}
                className={`admin-tab${isActive ? ' active' : ''}`}
              >
                {tab.label}
              </button>
            );
          })}
        </div>

        {selectedTab === 'settings' && (
          <AdminSettingsTab
            systemPrompt={systemPrompt}
            hasCustomSystemPrompt={hasCustomSystemPrompt}
            onSystemPromptChange={(value) => setSystemPrompt(value)}
            systemPromptMessage={systemPromptMessage}
            isSavingSystemPrompt={isSavingSystemPrompt}
            onSaveSystemPrompt={handleSaveSystemPrompt}
            koboFormUrl={koboFormUrl}
            onKoboFormUrlChange={(value) => setKoboFormUrl(value)}
            koboFormUid={koboFormUid}
            koboMessage={koboUrlMessage}
            isSavingKobo={isSavingKoboUrl}
            onSaveKobo={handleSaveKoboUrl}
            readOnly={readOnly}
          />
        )}

        {selectedTab === 'vignettes' && (
          <AdminVignettesTab
            vignettes={vignettes}
            caseTemplate={caseTemplate}
            message={message}
            vignetteMessages={vignetteMessages}
            swappingOrder={swappingOrder}
            deletingVignetteKey={deletingVignetteKey}
            savingVignetteIndex={savingVignetteIndex}
            onVignetteKeyChange={handleVignetteKeyChange}
            onVignetteContentChange={handleVignetteContentChange}
            onMoveVignette={handleMoveVignette}
            onDeleteVignette={handleDeleteVignette}
            onSaveVignette={handleSaveVignette}
            onAddVignette={handleAddVignette}
            editingIndex={editingVignetteIndex}
            editingDraft={editingDraft}
            hasUnsavedChanges={hasUnsavedChanges}
            onStartEditing={handleStartEditingVignette}
            onDiscardEditing={handleDiscardVignetteChanges}
            readOnly={readOnly}
          />
        )}

        {selectedTab === 'assignments' && (
          <AdminAssignmentsTab
            assignments={assignments}
            assignmentsMessage={assignmentsMessage}
            isLoadingAssignments={isLoadingAssignments}
            newAssignmentUid={newAssignmentUid}
            newAssignmentVignetteKey={newAssignmentVignetteKey}
            onAssignmentUidChange={(value) => setNewAssignmentUid(value)}
            onAssignmentVignetteChange={(value) => setNewAssignmentVignetteKey(value)}
            onAddAssignment={handleAddAssignment}
            isAddingAssignment={isAddingAssignment}
            vignettes={vignettes}
            deletingAssignmentId={deletingAssignmentId}
            onDeleteAssignment={handleDeleteAssignment}
            bulkFileInputRef={bulkFileInputRef}
            bulkImportMessage={bulkImportMessage}
            bulkPreview={bulkPreview}
            bulkFileName={bulkFileName}
            onBulkFileChange={handleBulkFileChange}
            onBulkImport={handleBulkImport}
            isImportingBulk={isImportingBulk}
            bulkImportLimit={BULK_IMPORT_ROW_LIMIT}
            selectedAssignmentIds={selectedAssignmentIds}
            selectedAssignmentCount={selectedAssignmentCount}
            isAllAssignmentsSelected={isAllAssignmentsSelected}
            onToggleAssignmentSelection={handleToggleAssignmentSelection}
            onToggleAllAssignmentsSelection={handleToggleAllAssignmentsSelection}
            onBulkDeleteSelected={handleOpenBulkDeleteModal}
            isBulkDeleting={isBulkDeleting}
          />
        )}

        {selectedTab === 'translations' && (
          <AdminTranslationsTab
            languagesJson={languagesJson}
            onLanguagesJsonChange={(value) => setLanguagesJson(value)}
            onLanguagesFileUpload={handleLanguagesFileUpload}
            languagesMessage={languagesMessage}
            isSavingLanguages={isLoadingLanguages}
            onSaveLanguages={handleSaveLanguages}
            readOnly={readOnly}
          />
        )}

        {selectedTab === 'usage' && (
          <AdminUsageTab
            usage={usageData}
            sessionStats={sessionStats}
            isLoading={isLoadingUsage}
            days={usageDays}
            readOnly={readOnly}
            onDaysChange={(d) => { setUsageDays(d); loadUsage(d); }}
            onRefresh={() => loadUsage()}
          />
        )}

        {message && selectedTab !== 'vignettes' && (
          <div className={`admin-msg admin-mt ${message.type === 'success' ? 'admin-msg-success' : 'admin-msg-error'}`}>
            {message.text}
          </div>
        )}
        {selectedTab === 'assignments' && isBulkDeleteModalOpen && (
          <div className="admin-modal-overlay">
            <div role="dialog" aria-modal="true" className="admin-modal">
              <h3>Delete assignments?</h3>
              <p>
                Are you sure you want to delete {selectedAssignmentCount} assignment{selectedAssignmentCount === 1 ? '' : 's'}? This action cannot be undone.
              </p>
              <div className="admin-modal-actions">
                <button
                  onClick={handleCloseBulkDeleteModal}
                  disabled={isBulkDeleting}
                  className="admin-btn admin-btn-secondary"
                >
                  Cancel
                </button>
                <button
                  onClick={handleConfirmBulkDelete}
                  disabled={isBulkDeleting}
                  className="admin-btn admin-btn-danger"
                >
                  {isBulkDeleting ? 'Deleting...' : 'Delete'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

