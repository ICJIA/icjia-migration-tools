/**
 * @module config.prod
 * @description Production migration configuration.
 *
 * Use this profile for the actual production migration cutover:
 *   - Strapi 3: production ICJIA public website API (read-only, remote)
 *   - Strapi 5: production-deployed Strapi 5 instance (remote)
 *
 * To use: cp config.prod.js config.js
 * Or: MIGRATION_ENV=prod node migration/scripts/04-run-phase.js
 *
 * NOTE: Production Strapi 5 hostname is a placeholder — update to the actual
 * deployed URL once provisioned. Set STRAPI5_TOKEN in the environment before
 * running write phases against production.
 */

export default {
  strapi3: {
    graphqlUrl: 'https://agency.icjia-api.cloud/graphql',
    apiUrl: 'https://agency.icjia-api.cloud',
    token: '',
    sqliteDbPath: process.env.STRAPI3_SQLITE_PATH || './docs/strapi-3-source/data.db',
  },

  strapi5: {
    // TODO: replace placeholder with the production hostname when provisioned
    graphqlUrl: process.env.STRAPI5_GRAPHQL_URL || 'https://v2.agency.icjia-api.cloud/graphql',
    apiUrl: process.env.STRAPI5_API_URL || 'https://v2.agency.icjia-api.cloud',
    token: process.env.STRAPI5_TOKEN || '', // REQUIRED for prod writes — set in env
    dbPath: process.env.STRAPI5_DB_PATH || '/var/www/icjia-public-strapi5/.tmp/data.db',
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

  includeDrafts: true,

  settings: {
    paginationLimit: 100,
    // Higher delay in prod to be gentle on shared infrastructure
    requestDelayMs: 200,
    requestTimeoutMs: 60000,
    pollMaxAttempts: 60,
    pollDelayMs: 2000,
  },
};
