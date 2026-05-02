/**
 * @module config
 * @description Single source of truth for all migration configuration.
 *
 * There are two ways to configure:
 *
 * **Option A: Copy a profile** (recommended)
 *   cp config.dev.js config.js    # Local dev: remote Strapi 3, local Strapi 5
 *   cp config.prod.js config.js   # Production: remote Strapi 3, remote Strapi 5
 *
 * **Option B: Use MIGRATION_ENV**
 *   MIGRATION_ENV=dev node migration/scripts/01-run-phase.js
 *   MIGRATION_ENV=prod node migration/scripts/02-run-phase.js
 *
 * **Option C: Copy this file and customize**
 *   cp config.example.js config.js
 *
 * `config.js` is gitignored (it may contain API tokens).
 * All values have sensible defaults and can be overridden via environment variables.
 *
 * If `config.js` does not exist, scripts fall back to `config.example.js` defaults.
 *
 * Profiles:
 *   config.dev.js  — Strapi 3 remote (agency.icjia-api.cloud) + Strapi 5 local (localhost:1338)
 *   config.prod.js — Strapi 3 remote + Strapi 5 remote (production hostname)
 */

export default {
  /**
   * Strapi 3 (source) instance configuration.
   * Default points to the production ICJIA public website API.
   */
  strapi3: {
    /** @type {string} GraphQL endpoint for introspection and data extraction */
    graphqlUrl: process.env.STRAPI3_GRAPHQL_URL || 'https://agency.icjia-api.cloud/graphql',
    /** @type {string} REST API base URL for count endpoints and file downloads */
    apiUrl: process.env.STRAPI3_API_URL || 'https://agency.icjia-api.cloud',
    /** @type {string} API token for authenticated requests (leave empty if not required) */
    token: process.env.STRAPI3_TOKEN || '',
    /**
     * Path to a local copy of the Strapi 3 SQLite database.
     * Used as a ground-truth source for: draft records (which GraphQL filters out),
     * the `Form` content type (403'd via GraphQL unauthenticated), relation join-table
     * inspection, and validation cross-checks.
     * @type {string}
     */
    sqliteDbPath: process.env.STRAPI3_SQLITE_PATH || './docs/strapi-3-source/data.db',
  },

  /**
   * Strapi 5 (target) instance configuration.
   * Default points to a local development instance.
   */
  strapi5: {
    /** @type {string} GraphQL endpoint for schema verification */
    graphqlUrl: process.env.STRAPI5_GRAPHQL_URL || 'http://localhost:1338/graphql',
    /** @type {string} REST API base URL for content creation and media upload */
    apiUrl: process.env.STRAPI5_API_URL || 'http://localhost:1338',
    /** @type {string} Full-access API token for write operations */
    token: process.env.STRAPI5_TOKEN || '',
    /** @type {string} Path to Strapi 5 SQLite database (for timestamp restoration) */
    dbPath: process.env.STRAPI5_DB_PATH || '../icjia-public-strapi5/.tmp/data.db',
  },

  /**
   * Path to the in-repo copy of Strapi 3 source files
   * (api/<type>/models/*.settings.json + components/<cat>/<name>.json).
   * Phase 1 reads from here.
   * @type {string}
   */
  strapi3SourcePath: process.env.STRAPI3_SOURCE_PATH || './docs/strapi-3-source',

  /**
   * Path to the Strapi 5 project directory.
   * Used by Phase 1 to auto-copy generated schemas into src/api/ and src/components/.
   * @type {string}
   */
  strapi5ProjectPath: process.env.STRAPI5_PROJECT_PATH || '../icjia-public-strapi5',

  /**
   * File and directory paths used by all scripts.
   * All paths are relative to the project root.
   */
  paths: {
    /** @type {string} Central content-type manifest (the source of truth for what to migrate) */
    contentTypesManifest: './migration/config/content-types.json',
    /** @type {string} GraphQL/SQLite introspection output */
    introspection: './migration/data/introspection',
    /** @type {string} Generated Strapi 5 schema files and boilerplate */
    output: './migration/output/strapi5-schemas',
    /** @type {string} Field type mapping rules (static config) */
    fieldTypeMap: './migration/config/field-type-map.json',
    /** @type {string} Generated field mapping details (output of Phase 1b) */
    fieldMap: './migration/config/field-map.json',
    /** @type {string} Persisted relation graph (output of Phase 1, consumed by Phase 4) */
    relationGraph: './migration/data/relation-graph.json',
    /** @type {string} Raw extracted data from Strapi 3 (Phase 2 output) */
    rawData: './migration/data/raw',
    /** @type {string} Transformed data ready for Strapi 5 loading (Phase 3 output) */
    transformedData: './migration/data/transformed',
    /** @type {string} Decoded media files and manifest (Phase 3 working directory) */
    media: './migration/data/media',
    /** @type {string} ID and media translation maps (used across phases) */
    maps: './migration/data/maps',
  },

  /**
   * Migrate draft records (records with NULL `published_at` in source).
   * For ICJIA's public website, drafts exist on Publication (32), Job (13),
   * Post (5), and Meeting (2). Strapi 5 marks them as drafts via the
   * draft/publish workflow (publishedAt: null).
   * Set to false to skip drafts.
   * @type {boolean}
   */
  includeDrafts: true,

  /**
   * Script behavior settings.
   */
  settings: {
    /** @type {number} Pagination limit for GraphQL queries */
    paginationLimit: 100,
    /** @type {number} Delay in ms between API requests to avoid overwhelming Strapi */
    requestDelayMs: 100,
    /** @type {number} Timeout in ms for individual API requests */
    requestTimeoutMs: 30000,
    /** @type {number} Max attempts when polling for Strapi 5 readiness */
    pollMaxAttempts: 30,
    /** @type {number} Delay in ms between poll attempts */
    pollDelayMs: 2000,
  },
};
