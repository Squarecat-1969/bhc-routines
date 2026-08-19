export type IssueCode =
  | 'S1' | 'S2' | 'S3' | 'S4' | 'S5'
  | 'G1' | 'G2' | 'G3'
  | 'A1' | 'A2' | 'A3' | 'A4' | 'A5'
  | 'I1';

export type Severity = 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';

/** Spec PASS 5's code -> (type, severity) table, transcribed exactly. */
export const ISSUE_META: Readonly<Record<IssueCode, { type: string; severity: Severity }>> = {
  S1: { type: 'Duplicate BHC_ID', severity: 'HIGH' },
  S2: { type: 'Missing BHC_ID', severity: 'HIGH' },
  S3: { type: 'Location/pointer mismatch', severity: 'MEDIUM' },
  S4: { type: 'Duplicate Attio pointer', severity: 'HIGH' },
  S5: { type: 'Implausible Google_Row', severity: 'MEDIUM' },
  G1: { type: 'Google row mismatch', severity: 'HIGH' },
  G2: { type: 'Google row empty', severity: 'LOW' },
  G3: { type: 'Google row out of bounds', severity: 'MEDIUM' },
  A1: { type: 'Attio ID mismatch', severity: 'HIGH' },
  A2: { type: 'Attio ID missing', severity: 'LOW' },
  A3: { type: 'Attio record not found', severity: 'HIGH' },
  A4: { type: 'Attio lookup failed', severity: 'INFO' },
  A5: { type: 'Attio name mismatch', severity: 'HIGH' },
  I1: { type: 'Identity field drift', severity: 'MEDIUM' },
};

export interface MasterRow {
  readonly bhcId: string;
  readonly fullName: string;
  readonly location: string;
  readonly googleRow: number | null;
  readonly attioRecordId: string;
  readonly notes: string;
  readonly masterRow: number;
}

export interface Finding {
  readonly code: IssueCode;
  readonly row: MasterRow;
  readonly expected: string;
  readonly found: string;
  readonly notes: string;
}

export interface GoogleIdentity {
  readonly firstName: string;
  readonly lastName: string;
  readonly title: string;
  readonly company: string;
  readonly primaryEmail: string;
}

export interface NameConflictCandidate {
  readonly bhcId: string;
  readonly oldName: string; // Attio live name
  readonly newName: string; // Google first+last
  readonly googleRow: number | null;
  readonly attioRecordId: string;
  readonly masterRow: number;
}

export interface ReconcilerCounts {
  readonly totalRowsChecked: number;
  readonly high: number;
  readonly medium: number;
  readonly low: number;
  readonly info: number;
  readonly clean: number;
  readonly superseded: number;
}
