/**
 * @clearview/shared — the ontology type contract shared by `api` and `web`.
 *
 * This is the TypeScript reflection of the Palantir-style ontology defined in
 * docs/01-structure-design.md (§2 Ontology, §4 Cross-Verification). The database
 * is a GENERIC object store, so most per-type fields live in `properties` (JSONB);
 * only the state triplet is promoted to first-class columns.
 */
export * from './ontology/objects';
export * from './ontology/events';
export * from './api/objects.contract';
export * from './api/reports.contract';
export * from './api/uploads.contract';
export * from './api/verification.contract';
export * from './api/recommendation.contract';
export * from './api/overview.contract';
