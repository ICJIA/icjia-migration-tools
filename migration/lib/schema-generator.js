/**
 * @module schema-generator
 * @description Generates Strapi 5 schema.json files from Strapi 3 model definitions.
 *
 * This is the core transformation engine for Phase 1 of the migration.
 * It handles:
 * - Field type mapping (string → string, text → text, etc.)
 * - Override mappings (article.splash: string → media for Base64 fields)
 * - Upload plugin conversion (model: file, plugin: upload → media field)
 * - Relation conversion (Strapi 3 collection/via/dominant → Strapi 5 inversedBy/mappedBy)
 * - legacyId injection (added to every content type for migration traceability)
 * - Boilerplate generation (route/controller/service files for each content type)
 *
 * The relation graph forms a triangle:
 *   article ↔ dataset (article dominant)
 *   article ↔ app     (app dominant)
 *   app     ↔ dataset (app dominant)
 *
 * @example
 *   import { generateStrapi5Schemas } from '../lib/schema-generator.js';
 *   const result = generateStrapi5Schemas(strapi3Models, fieldTypeMap);
 *   // result.article.schema → Strapi 5 schema.json object
 *   // result.article.boilerplate → { route, controller, service } strings
 *   // result.article.fieldMap → per-field mapping details
 */

/** @type {Record<string, string>} Human-readable descriptions for each content type */
const CONTENT_TYPE_DESCRIPTIONS = {
  article: 'Research articles with markdown body, images, and media attachments',
  dataset: 'Downloadable datasets with metadata, variables, and file attachments',
  app: 'Dashboard apps with image, description, and links to articles and datasets',
};

/**
 * Build a relation graph across all models to determine dominance.
 *
 * Scans every attribute in every model. For each relation field (identified by
 * having a `collection` or `model` property without `plugin: "upload"`), records
 * whether this side is dominant (`dominant: true` in Strapi 3).
 *
 * This cross-model pass is necessary because Strapi 5 relation conversion requires
 * knowing BOTH sides: the dominant side gets `inversedBy`, the non-dominant gets `mappedBy`.
 *
 * @param {Object} models - Strapi 3 models keyed by content type name
 * @returns {Map<string, {target: string, via: string|null, dominant: boolean, isCollection: boolean}>}
 *   Map keyed by "contentType.fieldName" with relation metadata
 */
function buildRelationGraph(models) {
  const graph = new Map();

  for (const [ctName, model] of Object.entries(models)) {
    for (const [fieldName, def] of Object.entries(model.attributes || {})) {
      // Skip upload plugin refs — those become media fields, not relations
      if (def.plugin === 'upload') continue;

      const target = def.collection || def.model;
      if (!target) continue;

      graph.set(`${ctName}.${fieldName}`, {
        target,
        via: def.via || null,
        dominant: def.dominant === true,
        isCollection: !!def.collection,
      });
    }
  }

  return graph;
}

/**
 * Convert a single Strapi 3 attribute definition to its Strapi 5 equivalent.
 *
 * Handles four categories of attributes:
 * 1. Upload plugin references → media fields
 * 2. Relations to other content types → relation fields with inversedBy/mappedBy
 * 3. Override fields (e.g., Base64 string → media) → custom definitions from field-type-map.json
 * 4. Standard typed fields → direct type mapping with constraint preservation
 *
 * @param {string} ctName - Content type name (e.g., "article")
 * @param {string} fieldName - Attribute name (e.g., "splash")
 * @param {Object} def - Strapi 3 attribute definition from the model
 * @param {Object} fieldTypeMap - Parsed field-type-map.json with directMappings and overrides
 * @param {Map} relationGraph - Relation graph from buildRelationGraph()
 * @returns {Object} Strapi 5 attribute definition
 */
function convertAttribute(ctName, fieldName, def, fieldTypeMap, relationGraph) {
  // Upload plugin → media field
  if (def.plugin === 'upload') {
    const allowedTypes = fieldTypeMap.uploadPluginAllowedTypes?.[fieldName] || ['files', 'images'];
    return {
      type: 'media',
      allowedTypes,
      multiple: !!def.collection, // "model" = single file, "collection" = multiple files
    };
  }

  // Relation to another content type (has collection or model, but NOT upload plugin)
  if (def.collection || (def.model && !def.type)) {
    const target = def.collection || def.model;
    const relationType = def.collection ? 'manyToMany' : 'manyToOne';
    const targetApi = `api::${target}.${target}`;

    const attr = {
      type: 'relation',
      relation: relationType,
      target: targetApi,
    };

    // Determine inversedBy vs mappedBy based on dominance
    if (def.via) {
      if (def.dominant) {
        // This side owns the join table → inversedBy
        attr.inversedBy = def.via;
      } else {
        // This side is non-dominant → mappedBy
        attr.mappedBy = def.via;
      }
    }

    return attr;
  }

  // Check for field-level override (e.g., article.splash: string → media)
  const overrideKey = `${ctName}.${fieldName}`;
  if (fieldTypeMap.overrides?.[overrideKey]) {
    return { ...fieldTypeMap.overrides[overrideKey].to };
  }

  // Slug fields → uid type with auto-generation from title
  if (fieldName === 'slug' && def.type === 'string') {
    return {
      type: 'uid',
      targetField: 'title',
    };
  }

  // Markdown/body field → richtext for large editing experience in admin
  if (fieldName === 'markdown' && (def.type === 'text' || def.type === 'richtext')) {
    return {
      type: 'richtext',
    };
  }

  // Standard typed field — map type and preserve constraints
  if (def.type) {
    const mappedType = fieldTypeMap.directMappings?.[def.type] || def.type;
    const attr = { type: mappedType };

    // Preserve any field-level constraints from Strapi 3
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

  // Unknown field shape — pass through as-is with a warning
  console.warn(`  WARNING: Unknown attribute shape for ${ctName}.${fieldName}:`, def);
  return def;
}

/**
 * Generate a complete Strapi 5 schema.json object for one content type.
 *
 * The generated schema includes:
 * - collectionType kind with plural collectionName
 * - info block with singularName, pluralName, displayName, description
 * - draftAndPublish: false
 * - legacyId as first attribute (string, unique)
 * - All scalar/media fields from the Strapi 3 model (converted)
 * - All relation fields at the end (converted with correct inversedBy/mappedBy)
 *
 * @param {string} ctName - Content type name (e.g., "article")
 * @param {Object} model - Parsed Strapi 3 .settings.json for this content type
 * @param {Object} fieldTypeMap - Parsed field-type-map.json
 * @param {Map} relationGraph - Relation graph from buildRelationGraph()
 * @returns {Object} Complete Strapi 5 schema.json object
 */
function generateSchema(ctName, model, fieldTypeMap, relationGraph) {
  const pluralName = ctName + 's';
  const displayName = ctName.charAt(0).toUpperCase() + ctName.slice(1);

  const schema = {
    kind: 'collectionType',
    collectionName: pluralName,
    info: {
      singularName: ctName,
      pluralName,
      displayName,
      description: CONTENT_TYPE_DESCRIPTIONS[ctName] || '',
    },
    options: {
      draftAndPublish: false,
    },
    attributes: {},
  };

  // Separate scalar/media fields from relations for ordering
  const scalarAttrs = {};
  const relationAttrs = {};

  for (const [fieldName, def] of Object.entries(model.attributes || {})) {
    const converted = convertAttribute(ctName, fieldName, def, fieldTypeMap, relationGraph);

    if (converted.type === 'relation') {
      relationAttrs[fieldName] = converted;
    } else {
      scalarAttrs[fieldName] = converted;
    }
  }

  // Title first (Strapi 5 uses the first string field as the relation display label),
  // then legacyId, then remaining scalars, then relations
  if (scalarAttrs.title) {
    schema.attributes.title = scalarAttrs.title;
    delete scalarAttrs.title;
  }

  schema.attributes.legacyId = {
    type: 'string',
    unique: true,
  };

  Object.assign(schema.attributes, scalarAttrs, relationAttrs);

  return schema;
}

/**
 * Generate minimal Strapi 5 boilerplate files (route, controller, service)
 * that are required alongside each schema.json.
 *
 * Uses CommonJS syntax (`require`/`module.exports`) because Strapi 5 projects
 * default to CommonJS (no `"type": "module"` in their package.json).
 *
 * @param {string} ctName - Content type name (e.g., "article")
 * @returns {{route: string, controller: string, service: string}} File contents as strings
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
 * Build a field map entry recording how each Strapi 3 field was converted.
 * This is written to config/field-map.json for reference and debugging.
 *
 * @param {string} ctName - Content type name
 * @param {Object} model - Original Strapi 3 model
 * @param {Object} schema - Generated Strapi 5 schema
 * @param {Object} fieldTypeMap - Parsed field-type-map.json
 * @returns {Object} Map of fieldName → { strapi3Type, strapi5Type, overridden, added? }
 */
function buildFieldMapEntry(ctName, model, schema, fieldTypeMap) {
  const entry = {};
  for (const [fieldName, def] of Object.entries(model.attributes || {})) {
    const strapi3Type = def.type || (def.plugin === 'upload' ? 'upload-plugin' : 'relation');
    const strapi5Attr = schema.attributes[fieldName];
    const strapi5Type = strapi5Attr?.type || 'unknown';
    const overrideKey = `${ctName}.${fieldName}`;
    const overridden = !!fieldTypeMap.overrides?.[overrideKey];

    entry[fieldName] = {
      strapi3Type,
      strapi5Type,
      overridden,
    };
  }
  // Include the migration-added legacyId field
  entry.legacyId = {
    strapi3Type: null,
    strapi5Type: 'string',
    overridden: false,
    added: true,
  };
  return entry;
}

/**
 * Main entry point. Generates all Strapi 5 schemas from Strapi 3 models.
 *
 * For each content type, produces:
 * - `schema`: A complete Strapi 5 schema.json object
 * - `boilerplate`: Route, controller, and service file contents (strings)
 * - `fieldMap`: Per-field mapping details for debugging/reference
 *
 * @param {Object} strapi3Models - Parsed Strapi 3 models, keyed by content type name.
 *   Each value is a parsed `.settings.json` object with `attributes`, `info`, etc.
 * @param {Object} fieldTypeMap - Parsed `config/field-type-map.json` containing:
 *   - `directMappings`: {strapi3Type → strapi5Type} for standard field types
 *   - `overrides`: {"contentType.field" → {from, to, reason}} for special-case fields
 *   - `uploadPluginAllowedTypes`: {fieldName → string[]} for upload plugin fields
 * @returns {Object} Keyed by content type name, each value contains:
 *   - `schema` {Object} - Strapi 5 schema.json object
 *   - `boilerplate` {{route: string, controller: string, service: string}} - File contents
 *   - `fieldMap` {Object} - Per-field conversion details
 */
export function generateStrapi5Schemas(strapi3Models, fieldTypeMap) {
  const relationGraph = buildRelationGraph(strapi3Models);
  const result = {};

  for (const [ctName, model] of Object.entries(strapi3Models)) {
    const schema = generateSchema(ctName, model, fieldTypeMap, relationGraph);
    const boilerplate = generateBoilerplate(ctName);
    const fieldMap = buildFieldMapEntry(ctName, model, schema, fieldTypeMap);

    result[ctName] = { schema, boilerplate, fieldMap };
  }

  return result;
}
