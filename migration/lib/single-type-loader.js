/**
 * @module single-type-loader
 * @description Strapi 5 single-type writer (e.g., Home).
 *
 * Strapi 5 single types use a different REST endpoint pattern than collections:
 *   - Collection: POST/PUT /api/<plural>/:documentId
 *   - Single:     PUT /api/<singularName> (no documentId; the singleton always exists)
 *
 * This module wraps the rest-client to encapsulate that.
 *
 * @example
 *   import { upsertSingleType } from '../lib/single-type-loader.js';
 *   const result = await upsertSingleType(client, 'home', { homeBanner: { ... } });
 */

/**
 * Upsert a single-type record. Strapi 5 auto-creates the singleton if it
 * doesn't exist; subsequent calls update it.
 *
 * @param {RestClient} client
 * @param {string} singularName - e.g., "home"
 * @param {Object} data - The record body (without `data:` wrapper — that's added)
 * @returns {Promise<Object>} The Strapi 5 record (data + meta)
 */
export async function upsertSingleType(client, singularName, data) {
  // Strapi 5 single types accept PUT to /api/<singularName>.
  // RestClient.put auto-wraps the body as { data: ... }, so pass `data` directly.
  return client.put(`/api/${singularName}`, data);
}

/**
 * Fetch the current state of a single-type record (or null if it doesn't
 * exist yet).
 */
export async function getSingleType(client, singularName) {
  try {
    const path = `/api/${singularName}`;
    const result = await client.get(path);
    return result.data || null;
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}
