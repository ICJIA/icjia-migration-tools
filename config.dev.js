/**
 * @module config.dev
 * @description Development/testing configuration.
 *
 * Use this profile for local testing:
 *   - Strapi 3: production ICJIA public website API (read-only, remote)
 *   - Strapi 5: local instance on your Mac (localhost:1338)
 *
 * To use: cp config.dev.js config.js
 * Or: MIGRATION_ENV=dev node migration/scripts/01-run-phase.js
 */

export default {
  strapi3: {
    graphqlUrl: 'https://agency.icjia-api.cloud/graphql',
    apiUrl: 'https://agency.icjia-api.cloud',
    token: '', // Production Strapi 3 — no token needed for public GraphQL
    sqliteDbPath: process.env.STRAPI3_SQLITE_PATH || './docs/strapi-3-source/data.db',
  },

  strapi5: {
    graphqlUrl: 'http://localhost:1338/graphql',
    apiUrl: 'http://localhost:1338',
    token: process.env.STRAPI5_TOKEN || '', // Set after creating token in local Strapi 5 admin
    dbPath: process.env.STRAPI5_DB_PATH || '../icjia-public-strapi5/.tmp/data.db',
  },

  strapi3SourcePath: './docs/strapi-3-source',
  strapi5ProjectPath: process.env.STRAPI5_PROJECT_PATH || '../icjia-public-strapi5',

  paths: {
    contentTypesManifest: './migration/config/content-types.json',
    introspection: './migration/data/introspection',
    output: './migration/output/strapi5-schemas',
    fieldTypeMap: './migration/config/field-type-map.json',
    fieldMap: './migration/config/field-map.json',
    relationGraph: './migration/data/relation-graph.json',
    rawData: './migration/data/raw',
    transformedData: './migration/data/transformed',
    media: './migration/data/media',
    maps: './migration/data/maps',
  },

  // Include drafts (records with NULL published_at) in the migration.
  includeDrafts: true,

  // When false (default), source drafts load into Strapi 5 as PUBLISHED
  // (publishedAt inferred from created_at). The editor flips individual
  // records back to draft post-migration as needed. Set true to map
  // source drafts 1:1 to Strapi 5 drafts.
  preserveSourceDrafts: false,

  settings: {
    paginationLimit: 100,
    requestDelayMs: 100,
    requestTimeoutMs: 30000,
    pollMaxAttempts: 30,
    pollDelayMs: 2000,
  },
};
