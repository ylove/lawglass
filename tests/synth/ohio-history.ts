/** Invented names and dates in the structural classes observed on Ohio's pages. */
export function makeOhioHistoryPages(): {
  status: string;
  documents: string;
  committee: string;
} {
  const frame = (
    kind: string,
    content: string,
  ) => `<html><body><main class="legislation">
    <h1>House Bill 9001 ${kind}</h1><nav class="section-menu">
    <a href="/legislation/135/hb9001/status">Status</a>
    <a href="/legislation/135/hb9001/documents">Documents</a>
    <a href="/legislation/135/hb9001/committee">Committee Activity</a></nav>
    <section class="legislation-primary-sponsors"><h2>Primary Sponsors</h2>
      <div class="media-container"><a href="https://ohiohouse.gov/members/alex-example" aria-label="Alex Example"><div>Alex Example</div></a></div>
      <div class="other-primary-sponsors"><div><span>Archived Example</span></div></div>
    </section><section class="legislation-cosponsors"><h2>Cosponsors</h2>
      <div class="legislation-cosponsors-inner"><div class="legislation-cosponsors-header">Senators</div>
        <div><a href="https://www.ohiosenate.gov/members/sam-sample">Sam Sample</a></div><div><span>Archived Senator</span></div>
      </div></section><div class="content-area-1">${content}</div></main></body></html>`;
  const action = (
    date: string,
    chamber: string,
    text: string,
    committee = '',
  ) =>
    `<tr><th class="date-cell">${date}</th><td class="chamber-cell">${chamber}</td><td class="action-cell">${text}</td><td class="committee-cell">${committee}</td></tr>`;
  const link = (code: string, label: string) =>
    `<li><a href="https://search-prod.lis.state.oh.us/api/v2/general_assembly_135/legislation/hb9001/${code}/pdf/"><span>${label}</span><span class="file-format-icon">PDF</span></a></li>`;
  return {
    status: frame(
      'Status',
      `<table class="legislation-status-table"><thead><tr><th>Date</th><th>Chamber</th><th>Action</th><th>Committee</th></tr></thead><tbody>
      ${action('6-6-2024', '', 'Sent To The Governor')}
      ${action('6-5-2024', 'Senate', 'Conference report agreed to', 'Conference Committee on H.B. 9001')}
      ${action('6-4-2024', 'Senate', 'Passed')}
      ${action('6-3-2024', 'Senate', 'Reported - Substitute', 'Example Finance')}
      ${action('5-2-2024', 'House', 'Passed')}
      ${action('5-2-2024', 'House', 'Reported - Substitute', 'Example Finance')}
      ${action('2-8-2024', 'Senate', 'Introduced')}
      ${action('2-2-2024', 'House', 'Referred to committee', 'Example Finance')}
      ${action('2-1-2024', 'House', 'Introduced')}
    </tbody></table>`,
    ),
    documents: frame(
      'Documents',
      `<section class="legislation-section"><h2>Legislation Text</h2><ul>
      ${link('06_EN', 'As Enrolled')}${link('05_CR', 'As Reported By Committee of Conference')}${link('04_PS', 'As Passed By Senate')}${link('03_RS', 'As Reported By Senate Committee')}${link('02_PH', 'As Passed By House')}${link('01_RH', 'As Reported By House Committee')}${link('00_IN', 'As Introduced')}
      </ul></section><section class="legislation-section"><h2>Analysis</h2><ul><li><a href="/download?key=700">As Introduced<span class="file-format-icon">PDF</span></a></li></ul></section>
      <section class="legislation-section"><h2>Additional Documents</h2><ul>
        <li><a href="https://www.legislature.ohio.gov//download?key=701">Synopsis of Committee Amendments<span class="file-format-icon">PDF</span></a></li>
        <li><a href="/download?key=702">Sub Bill Comparative Synopsis<span class="file-format-icon">PDF</span></a></li>
      </ul></section>`,
    ),
    committee: frame(
      'Committee Activity',
      `<h2 class="screen-reader">Committee</h2><h2>House Committees</h2>
      <table class="committee-meeting-table"><tbody><tr><th class="committee-cell">Example Finance</th><td class="date-cell">March 4, 2024</td><td class="status-cell">1st Hearing</td><td class="bill-text-cell"><a href="https://search-prod.lis.state.oh.us/api/v2/general_assembly_135/legislation/hb9001/00_IN/pdf/">Download</a></td></tr></tbody></table>
      <div class="committee-meeting-testimony"><table class="committee-meeting-testimony-table"><tbody><tr><th class="witness-cell">Pat Witness</th><td class="witness-type">Sponsor</td><td><a href="/testimony.pdf">Download</a></td></tr></tbody></table></div>`,
    ),
  };
}
