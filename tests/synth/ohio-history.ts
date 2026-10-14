/**
 * Invented bills, names and dates in the shape the Ohio LIS JSON API returns
 * (`/legislation/<bill>/`, `/actions/`, `/meetings/`, `/amendments/`).
 */
export interface OhioHistoryJson {
  versions: string;
  actions: string;
  meetings: string;
  amendments: string;
}

const member = (
  first: string,
  last: string,
  id: number,
  party: string,
  chamber: string,
) => ({
  chamber,
  first_name: first,
  last_name: last,
  full_name: `${first} ${last}`,
  district: '42',
  member_id: id,
  member_lpid: `rep_${last.toLowerCase()}_${first.toLowerCase()}_1`,
  active: true,
  party,
});

const STAGES = [
  ['00', 'IN', 'As Introduced'],
  ['01', 'RH', 'As Reported by the House Finance Committee'],
  ['02', 'PH', 'As Passed by the House'],
  ['03', 'RS', 'As Reported by the Senate Finance Committee'],
  ['04', 'PS', 'As Passed by the Senate'],
  ['05', 'CR', 'As Reported by Committee of Conference'],
  ['06', 'EN', 'As Enrolled'],
] as const;

/** An HB 33-like record: 7 versions. The API lists them oldest first. */
export function makeOhioVersionsJson(
  overrides: Record<string, unknown> = {},
): unknown[] {
  return STAGES.map(([formatted, id, label]) => ({
    name: 'H. B. No. 9001',
    number: 'hb9001',
    chamber: 'House',
    short_title: 'Example operating appropriations',
    long_title: 'To appropriate example money for fiscal years 2030-2031.',
    version: label,
    version_id: id,
    formatted_version: formatted,
    effective_date: id === 'EN' ? '2024-07-04' : null,
    governor_signed_date: id === 'EN' ? '2024-07-03' : null,
    concurrence_date: id === 'CR' ? '2024-06-30' : null,
    download: `/api/v2/general_assembly_135/legislation/hb9001/${formatted}_${id}/pdf/`,
    download_html: `/api/v2/general_assembly_135/legislation/hb9001/${formatted}_${id}/html/`,
    sponsors: [member('Alex', 'Example', 1001, 'party_republican_1', 'House')],
    cosponsors: [
      member('Sam', 'Sample', 1002, 'party_democrat_1', 'Senate'),
      member('Pat', 'Placeholder', 1003, 'party_independent_1', 'House'),
      member('Kit', 'Unknown', 1004, 'party_other_9', 'House'),
    ],
    subjects: [{ primary: 'Finance', secondary: '' }],
    ...overrides,
  }));
}

export function makeOhioActionsJson(): unknown[] {
  const action = (
    occurred: string,
    chamber: string,
    text: string,
    cmte: string | null = null,
  ) => ({
    occurred: `${occurred}T12:00:00-04:00`,
    chamber,
    action: text,
    description: text,
    cmte_name: cmte,
    committee: cmte ?? '',
  });
  // The real endpoint lists newest first.
  return [
    action('2024-06-30', 'Senate', 'Conference report agreed to'),
    action('2024-06-15', 'Senate', 'Passed'),
    action('2024-05-03', 'Senate', 'Refer to Committee', 'Finance'),
    action('2024-04-26', 'House', 'Passed'),
    action('2024-02-16', 'House', 'Introduced'),
  ];
}

export function makeOhioMeetingsJson(): unknown[] {
  return [
    {
      meeting_date: '2024-03-04',
      chair: 'Pat Chair',
      canceled: false,
      chamber: 'house',
      committee: 'Finance',
    },
    {
      meeting_date: '2024-03-11',
      canceled: true,
      chamber: 'house',
      committee: 'Finance',
    },
  ];
}

export function makeOhioAmendmentsJson(): unknown[] {
  return [
    {
      amendment_number: 'am0168',
      legislation_number: 'hb9001',
      version: 'As Introduced',
      sponsors: [
        member('Alex', 'Example', 1001, 'party_republican_1', 'House'),
      ],
      link: '/api/v2/general_assembly_135/legislation/hb9001/amendments/am0168/pdf/',
    },
  ];
}

export function makeOhioHistoryJson(): OhioHistoryJson {
  return {
    versions: JSON.stringify(makeOhioVersionsJson()),
    actions: JSON.stringify(makeOhioActionsJson()),
    meetings: JSON.stringify(makeOhioMeetingsJson()),
    amendments: '[]',
  };
}
