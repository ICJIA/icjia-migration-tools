/**
 * @module schema-generator
 * @description Generates Strapi 5 schema.json files from a normalized Strapi 3 source schema.
 *
 * Core transformation engine for Phase 1 of the migration. Produces:
 *
 * 1. **Content-type schemas** — for `<strapi5ProjectPath>/src/api/<name>/content-types/<name>/schema.json`
 *    Handles both `collectionType` and `singleType` (Home is a singleType).
 *
 * 2. **Component schemas** — for `<strapi5ProjectPath>/src/components/<category>/<name>.json`
 *    Strapi 5 components are stored separately from content types and need their
 *    own schema files.
 *
 * 3. **Boilerplate** — minimal `route`/`controller`/`service` files per content type
 *    (CommonJS, the Strapi 5 default). Singletons get the same boilerplate.
 *
 * 4. **Relation graph** — persisted to `migration/data/relation-graph.json` for the
 *    Phase 4 relation engine to drive its n-pass linking.
 *
 * Key transformations:
 * - Field type pass-through via directMappings (string→string, etc.)
 * - Upload-plugin fields → media fields, preserving allowedTypes from source
 * - Relation fields → relation type with inversedBy (dominant) or mappedBy (inverse)
 * - Component fields pass through verbatim (Strapi 3 + Strapi 5 share the shape)
 * - `legacyId` injected on every collectionType (singletons skip — they have no array)
 * - Incomplete source relations (Policy.tags, RequiredForm.tags) get injected `via` + `dominant`
 * - The Post self-ref (`posts`/`post`) is dropped (0 records use it; manifest tags it as drop)
 *
 * @example
 *   import { generateStrapi5Schemas } from '../lib/schema-generator.js';
 *   const result = generateStrapi5Schemas(sourceSchema, fieldTypeMap);
 *   // result.contentTypes['post'] = { schema, boilerplate, fieldMap }
 *   // result.components['carousel.carousel'] = { category, name, schema }
 *   // result.relationGraph = [{ contentType, field, target, dominant, ... }, ...]
 */

const SELF_REF_DROPS = new Set([
  // Post has post.posts ↔ post.post self-ref with 0 records — drop both sides.
  'post.posts',
  'post.post',
]);

/**
 * Convert camelCase or snake_case to lowercase kebab-case.
 * Used to derive Strapi 5 pluralName from manifest queryName.
 *
 * @example
 *   camelToKebab('requiredForms')  // 'required-forms'
 *   camelToKebab('publications')   // 'publications'
 *   camelToKebab('biographies')    // 'biographies'
 */
function camelToKebab(s) {
  return s
    .replace(/_/g, '-')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase();
}

/**
 * Convert kebab-case to Title Case for displayName.
 *
 * @example
 *   titleCase('required-form')  // 'Required Form'
 *   titleCase('biography')      // 'Biography'
 */
function titleCase(s) {
  return s
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * Build a relation graph across all content types to determine dominance.
 * Reads attributes from each .settings.json model. Skips upload-plugin refs
 * (those become media fields, not relations) and self-ref drops.
 *
 * @param {Array<{manifest: Object, model: Object}>} contentTypeEntries
 * @returns {Map<string, {target, via, dominant, isCollection}>}
 */
function buildRelationGraph(contentTypeEntries) {
  const graph = new Map();
  for (const { manifest, model } of contentTypeEntries) {
    if (!model) continue;
    for (const [fieldName, def] of Object.entries(model.attributes || {})) {
      if (def.plugin === 'upload') continue;
      if (def.type === 'component') continue;
      if (SELF_REF_DROPS.has(`${manifest.name}.${fieldName}`)) continue;

      const target = def.collection || def.model;
      if (!target) continue;

      graph.set(`${manifest.name}.${fieldName}`, {
        contentType: manifest.name,
        field: fieldName,
        target,
        via: def.via || null,
        dominant: def.dominant === true,
        isCollection: !!def.collection,
        isModel: !!def.model && !def.collection,
      });
    }
  }
  return graph;
}

/**
 * Apply incomplete-relation fixups from field-type-map.json.
 * Currently a no-op: Policy.tags and RequiredForm.tags are intentionally
 * one-sided in the Strapi 3 source (no `via`, no `dominant`, no inverse field
 * on Tag). Strapi 5 supports one-sided manyToMany — they generate as
 * relations without `inversedBy` or `mappedBy`.
 *
 * Earlier versions injected `inversedBy: 'policies'` etc., but Tag has no
 * corresponding `policies` field for that to point at, so Strapi 5 rejected
 * the schema. Kept as a hook in case a future fix wants to actually mutate
 * Tag's schema to add the inverse fields.
 *
 * @returns {Object} The attribute definition (currently unchanged)
 */
function applyIncompleteRelationFix(ctName, fieldName, def, _fieldTypeMap) {
  return def;
}

/**
 * Convert a single Strapi 3 attribute to its Strapi 5 equivalent.
 *
 * Handles:
 * - Component fields (pass through — same shape in Strapi 5)
 * - Upload-plugin refs → media field, preserving allowedTypes from source
 * - Relations → inversedBy/mappedBy based on dominance
 * - Field-level overrides from field-type-map.json
 * - Slug fields → uid type
 * - Standard typed fields with constraint preservation
 */
function convertAttribute(ctName, fieldName, def, fieldTypeMap) {
  // Component-typed attribute (from Strapi 3, where home/page/meeting/job already use them)
  if (def.type === 'component') {
    const attr = {
      type: 'component',
      repeatable: !!def.repeatable,
      component: def.component,
    };
    if (def.required) attr.required = true;
    if (def.min !== undefined) attr.min = def.min;
    if (def.max !== undefined) attr.max = def.max;
    return attr;
  }

  // Upload plugin → media field. Prefer source allowedTypes; fall back to field-type-map.
  if (def.plugin === 'upload') {
    const sourceAllowed = def.allowedTypes;
    const mapAllowed = fieldTypeMap.uploadPluginAllowedTypes?.[`${ctName}.${fieldName}`];
    const allowedTypes = sourceAllowed || mapAllowed || ['files', 'images', 'videos'];
    return {
      type: 'media',
      allowedTypes,
      multiple: !!def.collection, // model = single, collection = multiple
    };
  }

  // Relation to another content type
  if (def.collection || (def.model && !def.type)) {
    const target = def.collection || def.model;
    const relationType = def.collection ? 'manyToMany' : 'manyToOne';
    const targetApi = `api::${target}.${target}`;

    const attr = {
      type: 'relation',
      relation: relationType,
      target: targetApi,
    };

    if (def.via) {
      if (def.dominant) {
        attr.inversedBy = def.via;
      } else {
        attr.mappedBy = def.via;
      }
    }
    return attr;
  }

  // Field-level override (e.g., for Base64-string-as-image fields — empty for ICJIA)
  const overrideKey = `${ctName}.${fieldName}`;
  if (fieldTypeMap.overrides?.[overrideKey]) {
    return { ...fieldTypeMap.overrides[overrideKey].to };
  }

  // Slug → uid auto-generated from title
  if (fieldName === 'slug' && def.type === 'string') {
    return { type: 'uid', targetField: 'title' };
  }

  // markdown/body → richtext for the admin editor experience
  if ((fieldName === 'markdown' || fieldName === 'body') && (def.type === 'text' || def.type === 'richtext')) {
    return { type: 'richtext' };
  }

  // Standard typed field — map and preserve constraints
  if (def.type) {
    const mappedType = fieldTypeMap.directMappings?.[def.type] || def.type;
    const attr = { type: mappedType };
    if (def.required) attr.required = true;
    if (def.unique) attr.unique = true;
    if (def.default !== undefined) attr.default = def.default;
    if (def.minLength !== undefined) attr.minLength = def.minLength;
    if (def.maxLength !== undefined) attr.maxLength = def.maxLength;
    if (def.min !== undefined) attr.min = def.min;
    if (def.max !== undefined) attr.max = def.max;
    if (def.enum) attr.enum = def.enum;
    if (def.targetField) attr.targetField = def.targetField;
    return attr;
  }

  // Unknown shape — pass through with a warning
  console.warn(`  WARNING: Unknown attribute shape for ${ctName}.${fieldName}:`, def);
  return def;
}

/**
 * Generate a Strapi 5 schema for one content type entry from the manifest.
 *
 * Schema layout:
 *   - kind: 'collectionType' | 'singleType'
 *   - collectionName: from manifest.sqlTable (matches the source DB table)
 *   - info: { singularName, pluralName, displayName, description }
 *   - options: { draftAndPublish }
 *   - attributes: title (if any), legacyId (collections only), scalars, relations, components
 */
function generateContentTypeSchema(entry, fieldTypeMap) {
  const { manifest, model } = entry;
  const ctName = manifest.name;
  const isSingle = manifest.kind === 'singleType';

  const singularName = manifest.singularName || ctName;
  let pluralName = camelToKebab(manifest.queryName || ctName);
  // Strapi 5 requires pluralName != singularName even for singletons.
  // For Home (queryName "home"), force "homes".
  if (pluralName === singularName) {
    pluralName = `${singularName}s`;
  }
  const displayName = titleCase(ctName);
  // manifest.notes are developer notes, not user-facing descriptions.
  // Leave description empty unless explicitly set in the source model's info block.
  const description = model?.info?.description || '';
  const draftAndPublish = manifest.draftAndPublish ?? model?.options?.draftAndPublish ?? false;

  const schema = {
    kind: isSingle ? 'singleType' : 'collectionType',
    collectionName: manifest.sqlTable || pluralName.replace(/-/g, '_'),
    info: {
      singularName,
      pluralName,
      displayName,
      description,
    },
    options: {
      draftAndPublish,
    },
    attributes: {},
  };

  const scalarAttrs = {};
  const relationAttrs = {};
  const componentAttrs = {};

  for (const [fieldName, rawDef] of Object.entries(model?.attributes || {})) {
    if (SELF_REF_DROPS.has(`${ctName}.${fieldName}`)) continue;

    const def = applyIncompleteRelationFix(ctName, fieldName, rawDef, fieldTypeMap);
    const converted = convertAttribute(ctName, fieldName, def, fieldTypeMap);

    if (converted.type === 'relation') relationAttrs[fieldName] = converted;
    else if (converted.type === 'component') componentAttrs[fieldName] = converted;
    else scalarAttrs[fieldName] = converted;
  }

  // Title first if present (Strapi 5 uses the first string field as the relation display label)
  if (scalarAttrs.title) {
    schema.attributes.title = scalarAttrs.title;
    delete scalarAttrs.title;
  }

  // legacyId on collection types only (singletons have no array semantics, no idempotency need)
  if (!isSingle) {
    schema.attributes.legacyId = {
      type: 'integer',
      unique: true,
      configurable: false,
    };
  }

  // Scalars, then components, then relations
  Object.assign(schema.attributes, scalarAttrs, componentAttrs, relationAttrs);

  return schema;
}

/**
 * Generate a Strapi 5 component schema from a manifest+model entry.
 * Strapi 5 components are stored at src/components/<category>/<name>.json.
 */
function generateComponentSchema(entry, fieldTypeMap) {
  const { manifest, model } = entry;
  const collectionName = `components_${manifest.category.replace(/-/g, '_')}_${manifest.name.replace(/-/g, '_')}s`;

  const schema = {
    collectionName,
    info: {
      displayName: titleCase(manifest.name),
      description: '',
      icon: 'cube',
    },
    options: {},
    attributes: {},
  };

  // For components, "this" is the component itself — there's no host content type;
  // pass an empty incompleteRelations key by using a dummy ctName.
  const dummyCtName = `${manifest.category}.${manifest.name}`;
  for (const [fieldName, rawDef] of Object.entries(model?.attributes || {})) {
    schema.attributes[fieldName] = convertAttribute(dummyCtName, fieldName, rawDef, fieldTypeMap);
  }

  return schema;
}

/**
 * Generate minimal Strapi 5 boilerplate (route, controller, service) for a content type.
 * Uses CommonJS to match Strapi 5 project defaults.
 */
function generateBoilerplate(ctName) {
  const uid = `api::${ctName}.${ctName}`;
  return {
    route: `'use strict';\nconst { createCoreRouter } = require('@strapi/strapi').factories;\nmodule.exports = createCoreRouter('${uid}');\n`,
    controller: `'use strict';\nconst { createCoreController } = require('@strapi/strapi').factories;\nmodule.exports = createCoreController('${uid}');\n`,
    service: `'use strict';\nconst { createCoreService } = require('@strapi/strapi').factories;\nmodule.exports = createCoreService('${uid}');\n`,
  };
}

/**
 * Build a per-field mapping entry recording how each Strapi 3 field was converted.
 * Written to migration/config/field-map.json for reference and debugging.
 */
function buildFieldMapEntry(entry, schema, fieldTypeMap) {
  const { manifest, model } = entry;
  const result = {};
  for (const [fieldName, def] of Object.entries(model?.attributes || {})) {
    if (SELF_REF_DROPS.has(`${manifest.name}.${fieldName}`)) {
      result[fieldName] = { strapi3Type: def.type || 'relation', strapi5Type: 'DROPPED', dropped: true };
      continue;
    }
    const strapi3Type =
      def.type ||
      (def.plugin === 'upload' ? 'upload-plugin' : 'relation');
    const strapi5Attr = schema.attributes[fieldName];
    const strapi5Type = strapi5Attr?.type || 'unknown';
    const overrideKey = `${manifest.name}.${fieldName}`;
    const overridden = !!fieldTypeMap.overrides?.[overrideKey];

    result[fieldName] = { strapi3Type, strapi5Type, overridden };
  }
  // Always-injected legacyId for collection types
  if (manifest.kind !== 'singleType') {
    result.legacyId = { strapi3Type: null, strapi5Type: 'integer', overridden: false, added: true };
  }
  return result;
}

/**
 * Main entry point. Generates all Strapi 5 schemas from the normalized source.
 *
 * @param {{contentTypes: Array, components: Array}} sourceSchema
 *   Output of 01a-introspect.js — the normalized {manifest, model} pairs.
 * @param {Object} fieldTypeMap - Parsed field-type-map.json
 * @returns {{contentTypes, components, relationGraph}}
 *   - contentTypes: { [name]: { schema, boilerplate, fieldMap } }
 *   - components:   { [category.name]: { category, name, schema } }
 *   - relationGraph: array of dominance entries, dominant edges first
 */
export function generateStrapi5Schemas(sourceSchema, fieldTypeMap) {
  const relationGraphMap = buildRelationGraph(sourceSchema.contentTypes);

  const contentTypes = {};
  for (const entry of sourceSchema.contentTypes) {
    if (!entry.model) continue;
    const schema = generateContentTypeSchema(entry, fieldTypeMap);
    const boilerplate = generateBoilerplate(entry.manifest.name);
    const fieldMap = buildFieldMapEntry(entry, schema, fieldTypeMap);
    contentTypes[entry.manifest.name] = { schema, boilerplate, fieldMap };
  }

  const components = {};
  for (const entry of sourceSchema.components) {
    if (!entry.model) continue;
    const schema = generateComponentSchema(entry, fieldTypeMap);
    const key = `${entry.manifest.category}.${entry.manifest.name}`;
    components[key] = {
      category: entry.manifest.category,
      name: entry.manifest.name,
      schema,
    };
  }

  // Augment relation graph with the manifest's dominantRelations[] (already curated)
  // and serialize for Phase 4. Each entry has the info Phase 4's relation engine needs.
  const relationGraph = [];
  for (const entry of relationGraphMap.values()) {
    relationGraph.push(entry);
  }
  // Sort: dominant first, then by content type, then field
  relationGraph.sort((a, b) => {
    if (a.dominant !== b.dominant) return a.dominant ? -1 : 1;
    if (a.contentType !== b.contentType) return a.contentType.localeCompare(b.contentType);
    return a.field.localeCompare(b.field);
  });

  return { contentTypes, components, relationGraph };
}
