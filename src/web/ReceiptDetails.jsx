import React from 'react';
import './receipt-details.css';

export function ReceiptDetails({ review, view }) {
  if (!review) return null;
  if (review.kind === 'source-refresh') return <RefreshDetails review={review} view={view} />;
  const side = review.sides[view];
  return <div className="receipt-details">
    <section className="sidebar-section">
      <div className="section-heading"><h2>Source context</h2><span>{review.viewLabels[view]}</span></div>
      <p className="receipt-question">{side.scope.question}</p>
      <p className="receipt-revision">Revision <code title={side.revision}>{side.revision.slice(0, 10)}</code></p>
      <p className="sidebar-note">A scoped view of the inspected source. Runtime behavior has not been verified.</p>
    </section>
    <section className="sidebar-section">
      <div className="section-heading"><h2>Relationships</h2><span>{side.relations.length}</span></div>
      <ul className="receipt-relations">{side.relations.map((relation, index) => <li key={index}>
        <div className="receipt-relation-heading"><strong>{relation.from} → {relation.to}</strong><span className={`receipt-status is-${relation.status}`}>{relation.status}</span></div>
        <p>{relation.claim}</p>
        <span className="receipt-kind">{relation.kind === 'assumption' ? 'Assumption · unverified' : relation.kind === 'import' ? 'Import · not a runtime call' : 'Source-cited call'}</span>
        {relation.sources.length > 0 && <ul className="receipt-sources">{relation.sources.map((source, i) => <li key={i}><a href={source.url} target="_blank" rel="noopener noreferrer">{source.path}:{source.startLine}–{source.endLine} <span aria-hidden="true">↗</span></a></li>)}</ul>}
      </li>)}</ul>
    </section>
    <section className="sidebar-section">
      <div className="section-heading"><h2>Scope & unknowns</h2></div>
      <p className="sidebar-note">Partial analysis · {side.scope.paths.join(', ')}</p>
      <ul className="receipt-unknowns">{side.scope.unknowns.map((unknown, index) => <li key={index}>{unknown}</li>)}</ul>
    </section>
  </div>;
}


const FIELD_NAMES = { x: 'Horizontal position', y: 'Vertical position', width: 'Width', height: 'Height', text: 'Label', originalText: 'Label source', strokeColor: 'Stroke', backgroundColor: 'Fill' };
const CONFLICT_NAMES = { FIELD_CONFLICT: 'Both versions changed this field', MISSING_GENERATED_BASELINE: 'No accepted generated baseline', HUMAN_REMOVAL: 'Removed in your version', DELETE_MODIFIED_ELEMENT: 'Source removed an element you edited', UNRESOLVED_IDENTITY: 'Source identity needs reconciliation', NATIVE_ID_CHANGED: 'Native identity changed', ELEMENT_ID_COLLISION: 'Element identity already exists', BOUND_TEXT_ID_CHANGED: 'Bound label identity changed', TOPOLOGY_CONFLICT: 'Connections need reconciliation', ASSET_CONFLICT: 'Both versions changed an image' };
function readableValue(value) {
  if (!value?.present) return 'Unset';
  if (typeof value.value === 'object') return 'Changed structure';
  if (typeof value.value === 'number') return String(Math.round(value.value * 100) / 100);
  return String(value.value);
}
function RefreshDetails({ review, view }) {
  const blocked = review.status === 'reconciliation-required';
  const conflicts = review.conflicts.filter(item => item.field !== 'originalText' || !review.conflicts.some(other => other.elementId === item.elementId && other.field === 'text' && JSON.stringify([other.baseline, other.human, other.proposed]) === JSON.stringify([item.baseline, item.human, item.proposed]))).sort((a, b) => Number(b.field === 'text') - Number(a.field === 'text'));
  const grouped = new Map();
  for (const item of review.overrides) {
    if (!grouped.has(item.label)) grouped.set(item.label, new Set());
    grouped.get(item.label).add(({ x: 'Position', y: 'Position', text: 'Label', originalText: 'Label', width: 'Size', height: 'Size', points: 'Connection route' })[item.field] || FIELD_NAMES[item.field] || 'Appearance');
  }
  return <div className="receipt-details">
    <section className="sidebar-section">
      <div className="section-heading"><h2>Refresh status</h2></div>
      <p className="receipt-question">{blocked ? 'Needs reconciliation' : review.status === 'unchanged' ? 'Source is unchanged' : 'Candidate ready for review'}</p>
      <p className="sidebar-note">{blocked ? 'Conflicts prevent adoption. Review the proposal and any partial candidate before staging a resolved refresh.' : 'Staging keeps your accepted baseline unchanged. Adoption is a separate explicit command; this receipt does not record whether it happened later.'}</p>
      <p className="receipt-view-note">{view === 'before' ? 'Your diagram when refresh was staged.' : view === 'proposal' || review.viewLabels[view] === 'Source proposal' ? 'Generated from the inspected source, before preserving your overrides.' : blocked ? 'Partial candidate. Conflicts are unresolved.' : 'Merged candidate with your overrides preserved.'}</p>
    </section>
    {review.conflicts.length > 0 && <section className="sidebar-section">
      <div className="section-heading"><h2>Conflicts</h2><span>{conflicts.length}</span></div>
      <ul className="receipt-relations">{conflicts.map((item, index) => <li key={index}><strong>{item.label}{item.field ? ` · ${FIELD_NAMES[item.field] || item.field}` : ''}</strong><p>{CONFLICT_NAMES[item.code] || 'Manual reconciliation required'}</p>{item.code === 'FIELD_CONFLICT' && <dl className="receipt-conflict-values"><dt>Baseline</dt><dd>{readableValue(item.baseline)}</dd><dt>Yours</dt><dd>{readableValue(item.human)}</dd><dt>Proposal</dt><dd>{readableValue(item.proposed)}</dd></dl>}</li>)}</ul>
    </section>}
    <section className="sidebar-section">
      <div className="section-heading"><h2>Preserved overrides</h2><span>{grouped.size}</span></div>
      {review.overrides.length ? <ul className="receipt-unknowns">{[...grouped].map(([label, fields]) => <li key={label}>{label} · {[...fields].join(', ')}</li>)}</ul> : <p className="sidebar-note">No separate overrides were recorded.</p>}
      <p className="sidebar-note">{review.changes.length} source {review.changes.length === 1 ? 'field change' : 'field changes'} recorded by this refresh.</p>
    </section>
    <section className="sidebar-section">
      <div className="section-heading"><h2>Proposal scope & unknowns</h2></div>
      <p className="receipt-question">{review.source.scope.question}</p>
      <p className="receipt-revision">Revision <code title={review.source.revision}>{review.source.revision.slice(0, 10)}</code></p>
      <p className="sidebar-note">Partial analysis · {review.source.scope.paths.join(', ')}. Runtime behavior has not been verified.</p>
      <ul className="receipt-unknowns">{review.source.scope.unknowns.map((unknown, index) => <li key={index}>{unknown}</li>)}</ul>
    </section>
  </div>;
}
