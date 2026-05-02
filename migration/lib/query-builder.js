/**
 * @module query-builder
 * @description Generates GraphQL queries for Strapi 3 content extraction.
 *
 * Builds paginated queries from the normalized source schema (output of
 * 01a-introspect). For each content type, produces a single query that:
 *
 *   - Selects every scalar field (incl. enum, date, datetime, json, richtext)
 *   - Expands every UploadFile field with full metadata
 *   - Selects relations as `{ id }` only (resolved to documentId in Phase 4)
 *   - Recursively expands component fields, including nested components
 *   - Includes a `<plural>Connection { aggregate { count } }` for count cross-checks
 *
 * Strapi 3 GraphQL conventions:
 *   - Plural query: `{ posts(start: 0, limit: 100) { ... } }`
 *   - Singular query (single types): `{ home { ... } }`
 *   - Count: `{ postsConnection { aggregate { count } } }`
 *
 * @example
 *   import { buildQuery } from '../lib/query-builder.js';
 *   const { collectionQuery, countQuery } = buildQuery(typeEntry, sourceSchema);
 *   // collectionQuery: "{ posts(start: $start, limit: $limit) { ... } }"
 *   // countQuery: "{ postsConnection { aggregate { count } } }"
 */

/**
 * Standard fields to select from any UploadFile reference.
 * Mirrors Strapi 3's UploadFile type in GraphQL.
 */
const UPLOAD_FILE_FIELDS = [
  'id',
  'name',
  'hash',
  'ext',
  'mime',
  'size',
  'url',
  'alternativeText',
  'caption',
  'width',
  'height',
];

/**
 * Build a Map<componentRef, componentManifestEntry> from sourceSchema.components
 * where componentRef matches the `def.component` value used in attributes
 * (e.g., "carousel.carousel").
 */
function buildComponentLookup(sourceSchema) {
  const map = new Map();
  for (const entry of sourceSchema.components) {
    const ref = `${entry.manifest.category}.${entry.manifest.name}`;
    map.set(ref, entry);
  }
  return map;
}

/**
 * Recursively build the field selection for a component definition.
 * Components can nest other components (e.g., carousel.slide → slide.slide).
 *
 * @param {Object} componentEntry - { manifest, model } from sourceSchema.components
 * @param {Map} componentLookup - keyed by "category.name"
 * @param {Set<string>} visitedRefs - guard against cycles
 * @returns {string} The inside of `{ ... }` for this component's selection
 */
function buildComponentSelection(componentEntry, componentLookup, visitedRefs = new Set()) {
  const ref = `${componentEntry.manifest.category}.${componentEntry.manifest.name}`;
  if (visitedRefs.has(ref)) {
    // Cycle — bail out with just `id` to avoid infinite recursion
    return '    id';
  }
  visitedRefs.add(ref);

  const attrs = componentEntry.model?.attributes || {};
  const lines = ['    id'];

  for (const [fieldName, def] of Object.entries(attrs)) {
    if (def.type === 'component') {
      const nestedRef = def.component;
      const nestedEntry = componentLookup.get(nestedRef);
      if (nestedEntry) {
        const nestedSelection = buildComponentSelection(nestedEntry, componentLookup, new Set(visitedRefs));
        lines.push(`    ${fieldName} {`);
        lines.push(nestedSelection);
        lines.push('    }');
      } else {
        // Unknown component — fall back to id
        lines.push(`    ${fieldName} { id }`);
      }
    } else if (def.plugin === 'upload') {
      // UploadFile reference inside a component (e.g., slide.image)
      lines.push(`    ${fieldName} { ${UPLOAD_FILE_FIELDS.join(' ')} }`);
    } else if (def.collection || def.model) {
      // Relation inside a component (e.g., add-event.tags)
      lines.push(`    ${fieldName} { id }`);
    } else {
      // Scalar / enum / date / etc.
      lines.push(`    ${fieldName}`);
    }
  }

  return lines.join('\n');
}

/**
 * Build the field selection for a content type.
 * Always includes `id` and all timestamps. Adds `published_at` if the type
 * uses draftAndPublish.
 *
 * @param {Object} typeEntry - { manifest, model } from sourceSchema.contentTypes
 * @param {Map} componentLookup
 * @returns {string} The inside of `{ ... }` for the content type
 */
function buildContentTypeSelection(typeEntry, componentLookup) {
  const { manifest, model } = typeEntry;
  if (!model) {
    throw new Error(`No source model for content type ${manifest.name}`);
  }

  const attrs = model.attributes || {};
  const lines = ['    id'];

  // Always include timestamps — used by Phase 4c to restore them
  lines.push('    created_at');
  lines.push('    updated_at');
  if (model.options?.draftAndPublish) {
    lines.push('    published_at');
  }

  for (const [fieldName, def] of Object.entries(attrs)) {
    if (def.type === 'component') {
      const nestedRef = def.component;
      const nestedEntry = componentLookup.get(nestedRef);
      if (nestedEntry) {
        const sel = buildComponentSelection(nestedEntry, componentLookup);
        lines.push(`    ${fieldName} {`);
        lines.push(sel);
        lines.push('    }');
      } else {
        lines.push(`    ${fieldName} { id }`);
      }
    } else if (def.plugin === 'upload') {
      lines.push(`    ${fieldName} { ${UPLOAD_FILE_FIELDS.join(' ')} }`);
    } else if (def.collection || def.model) {
      // Relation — just the id
      lines.push(`    ${fieldName} { id }`);
    } else {
      // Scalar
      lines.push(`    ${fieldName}`);
    }
  }

  return lines.join('\n');
}

/**
 * Build the full GraphQL query for one content type.
 *
 * @param {Object} typeEntry - { manifest, model } from sourceSchema.contentTypes
 * @param {Object} sourceSchema - full normalized schema (needed for component lookup)
 * @returns {{ collectionQuery, countQuery, isSingleType }}
 *   collectionQuery: paginated query with $start, $limit (or single fetch for singletons)
 *   countQuery: the connection { aggregate { count } } query (null for singletons)
 */
export function buildQuery(typeEntry, sourceSchema) {
  const componentLookup = buildComponentLookup(sourceSchema);
  const isSingleType = typeEntry.manifest.kind === 'singleType';

  const selection = buildContentTypeSelection(typeEntry, componentLookup);

  if (isSingleType) {
    // Singletons: { home { ... } } — no pagination, no count query
    return {
      collectionQuery: `{\n  ${typeEntry.manifest.queryName} {\n${selection}\n  }\n}`,
      countQuery: null,
      isSingleType: true,
    };
  }

  // Plural query with start/limit pagination params
  const pluralQuery = typeEntry.manifest.queryName;
  const collectionQuery = `query Extract($start: Int!, $limit: Int!) {\n  ${pluralQuery}(start: $start, limit: $limit) {\n${selection}\n  }\n}`;

  const countQuery = `{\n  ${pluralQuery}Connection {\n    aggregate {\n      count\n    }\n  }\n}`;

  return { collectionQuery, countQuery, isSingleType: false };
}

/**
 * Convenience: build queries for every active content type in the manifest.
 * Returns a Map keyed by content type name.
 */
export function buildAllQueries(sourceSchema) {
  const result = new Map();
  for (const entry of sourceSchema.contentTypes) {
    if (!entry.model || entry.manifest.skipDefault) continue;
    result.set(entry.manifest.name, buildQuery(entry, sourceSchema));
  }
  return result;
}
