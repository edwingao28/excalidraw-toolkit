import React from 'react';
import './receipt-details.css';

export function ReceiptDetails({ review, view }) {
  if (!review) return null;
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
