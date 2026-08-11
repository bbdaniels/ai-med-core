export interface StatusMessage {
  type: 'success' | 'error';
  text: string;
}

export interface Vignette {
  id?: number;
  key: string;
  content: string;
  sort_order?: number;
}

export interface VignetteAssignment {
  id: number;
  uid: string;
  vignette_id: number;
  vignette_key?: string;
  created_at?: string;
}

export interface BulkCsvPreview {
  assignments: Array<{ uid: string; case: string }>;
  totalRows: number;
  blankRows: number;
  duplicates: number;
}

