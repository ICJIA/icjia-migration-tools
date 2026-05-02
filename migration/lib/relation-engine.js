/**
 * @module relation-engine
 * @description Generic n-pass relation linker for Strapi 5 migrations.
 *
 * Reads:
 *   - `migration/data/relation-graph.json` (built by Phase 1) — list of relation
 *     edges with their dominance flags and target types.
 *   - `migration/data/maps/<plural>.json` (built by Phase 4 load) — sourceId →
 *     strapi5DocumentId for each content type.
 *   - `migration/data/raw/<plural>.json` (built by Phase 2) — original extracts
 *     with relation field arrays of `{id}` references.
 *
 * For each content type that has dominant outbound relations (m2m or m2o):
 *   For each record:
 *     Build a single PUT body covering all relevant relation fields
 *     PUT /api/<plural>/<documentId> with { fieldA: { connect: [...] }, ... }
 *
 * Strapi 5's `connect` syntax is additive and idempotent — connecting an
 * already-connected relation is a no-op. Safe to re-run.
 *
 * @example
 *   import { linkAllRelations } from '../lib/relation-engine.js';
 *   const stats = await linkAllRelations(client, manifest, {
 *     relationGraph,
 *     idMaps,           // Map<typeName, Map<sourceId, documentId>>
 *     rawRecordsByType, // Map<typeName, Array<rawRecord>>
 *     onProgress: (info) => { ... },
 *     requestDelayMs: 100,
 *   });
 *   // stats.passes: [{ contentType, field, target, links, errors }, ...]
 *   // stats.totals: { passes, recordsLinked, links, errors }
 */

/**
 * Group dominant edges by source content type. Returns a Map keyed by source
 * type name, each value an array of edges originating from that type.
 *
 * @param {Array<Object>} relationGraph
 * @returns {Map<string, Array<Object>>}
 */
function groupDominantEdges(relationGraph) {
  const groups = new Map();
  for (const edge of relationGraph) {
    // Include both dominant m2m relations AND m2o relations (which always
    // live on one side regardless of `dominant` flag).
    const include = edge.dominant === true || edge.isModel === true;
    if (!include) continue;
    if (!groups.has(edge.contentType)) groups.set(edge.contentType, []);
    groups.get(edge.contentType).push(edge);
  }
  return groups;
}

/**
 * For one record, build the connect-style PUT body covering every dominant
 * outbound relation that has populated source IDs.
 *
 * @param {Object} record - The raw extract record (with relation fields as Array<{id}>)
 * @param {Array<Object>} edges - Dominant edges originating from this record's type
 * @param {Map<string, Map<string, string>>} idMapsByType - keyed by target type name
 * @returns {{body: Object, totalLinks: number, missingTargets: Array}}
 */
function buildConnectBody(record, edges, idMapsByType) {
  const body = {};
  let totalLinks = 0;
  const missingTargets = [];

  for (const edge of edges) {
    const value = record[edge.field];
    const targetMap = idMapsByType.get(edge.target);

    if (edge.isCollection) {
      // m2m: value is Array<{id}> or undefined/null
      if (!Array.isArray(value) || value.length === 0) continue;
      const connect = [];
      for (const item of value) {
        const sourceId = String(item.id);
        const docId = targetMap?.get(sourceId);
        if (docId) {
          connect.push({ documentId: docId });
        } else {
          missingTargets.push({ field: edge.field, target: edge.target, sourceId });
        }
      }
      if (connect.length > 0) {
        body[edge.field] = { connect };
        totalLinks += connect.length;
      }
    } else if (edge.isModel) {
      // m2o: value is {id} or null
      if (!value || typeof value !== 'object' || !value.id) continue;
      const sourceId = String(value.id);
      const docId = targetMap?.get(sourceId);
      if (docId) {
        body[edge.field] = { connect: [{ documentId: docId }] };
        totalLinks += 1;
      } else {
        missingTargets.push({ field: edge.field, target: edge.target, sourceId });
      }
    }
  }

  return { body, totalLinks, missingTargets };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Determine the REST plural URL segment from a manifest content-type entry.
 */
function restPluralName(manifestEntry) {
  if (manifestEntry.kind === 'singleType') return manifestEntry.name;
  return (manifestEntry.queryName || manifestEntry.name)
    .replace(/_/g, '-')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase();
}

/**
 * Link all dominant relations for every content type in the manifest.
 *
 * @param {RestClient} client
 * @param {{contentTypes: Array<Object>}} manifest
 * @param {{
 *   relationGraph: Array<Object>,
 *   idMapsByType: Map<string, Map<string, string>>,
 *   rawRecordsByType: Map<string, Array<Object>>,
 *   requestDelayMs?: number,
 *   onProgress?: ({contentType, recordIndex, total}) => void,
 * }} opts
 * @returns {Promise<{passes: Array, totals: Object}>}
 */
export async function linkAllRelations(client, manifest, opts) {
  const { relationGraph, idMapsByType, rawRecordsByType, requestDelayMs = 100, onProgress } = opts;

  const manifestByName = new Map(manifest.contentTypes.map((c) => [c.name, c]));
  const groups = groupDominantEdges(relationGraph);

  const passes = [];
  const totals = { passes: 0, recordsLinked: 0, links: 0, errors: 0 };

  for (const [ctName, edges] of groups) {
    const ctManifest = manifestByName.get(ctName);
    if (!ctManifest || ctManifest.skipDefault) continue;

    const records = rawRecordsByType.get(ctName) || [];
    const sourceIdMap = idMapsByType.get(ctName);
    if (!sourceIdMap) continue;

    const passInfo = {
      contentType: ctName,
      edges: edges.map((e) => ({ field: e.field, target: e.target })),
      recordsLinked: 0,
      links: 0,
      errors: [],
      missingTargets: [],
    };

    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      const sourceId = String(record.id);
      const docId = sourceIdMap.get(sourceId);
      if (!docId) {
        // Record wasn't loaded — skip its relations
        continue;
      }

      const { body, totalLinks, missingTargets } = buildConnectBody(record, edges, idMapsByType);
      passInfo.missingTargets.push(...missingTargets);

      if (totalLinks === 0) continue;

      try {
        await client.put(`/api/${restPluralName(ctManifest)}/${docId}`, body);
        passInfo.recordsLinked++;
        passInfo.links += totalLinks;
        if (requestDelayMs > 0) await sleep(requestDelayMs);
      } catch (err) {
        passInfo.errors.push({ sourceId, docId, error: err.message.slice(0, 300) });
      }

      if (onProgress) onProgress({ contentType: ctName, recordIndex: i + 1, total: records.length });
    }

    passes.push(passInfo);
    totals.passes++;
    totals.recordsLinked += passInfo.recordsLinked;
    totals.links += passInfo.links;
    totals.errors += passInfo.errors.length;
  }

  return { passes, totals };
}
