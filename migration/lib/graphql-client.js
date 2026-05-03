/**
 * @module graphql-client
 * @description Thin wrapper around `fetch` for GraphQL queries.
 *
 * Provides a reusable client for making authenticated GraphQL requests
 * with configurable timeout and clear error reporting. Used by Phase 1
 * (introspection) and Phase 2 (data extraction).
 *
 * @example
 *   import { GraphQLClient } from '../lib/graphql-client.js';
 *   const client = new GraphQLClient('http://localhost:1340/graphql', 'my-token');
 *   const result = await client.query('{ articles { id title } }');
 */

import { isHttpsOrLocalhost } from './security.js';

/**
 * A GraphQL client that wraps native `fetch` with auth, timeout, and error handling.
 */
export class GraphQLClient {
  /**
   * @param {string} endpoint - The GraphQL endpoint URL
   * @param {Object} [options] - Client options
   * @param {string} [options.token] - Bearer token for Authorization header (omitted if empty/null)
   * @param {number} [options.timeoutMs=30000] - Request timeout in milliseconds
   */
  constructor(endpoint, options = {}) {
    this.endpoint = endpoint;
    this.token = options.token || null;
    this.timeoutMs = options.timeoutMs || 30000;

    // Refuse to send a bearer token over plaintext HTTP to a non-localhost URL.
    // http://localhost, http://127.0.0.1, http://::1, http://0.0.0.0 are
    // explicitly allowed (dev workflow). Otherwise: HTTPS or set
    // ALLOW_INSECURE_HTTP=1 to override.
    if (this.token && !isHttpsOrLocalhost(endpoint)) {
      if (process.env.ALLOW_INSECURE_HTTP === '1') {
        console.warn(
          `\x1b[33mWARNING: Sending API token over plaintext HTTP to ${endpoint} ` +
            `(ALLOW_INSECURE_HTTP=1).\x1b[0m`,
        );
      } else {
        throw new Error(
          `Refusing to send API token over plaintext HTTP to ${endpoint}.\n` +
            `  Allowed without HTTPS: http://localhost, http://127.0.0.1, http://::1, http://0.0.0.0.\n` +
            `  Otherwise use HTTPS, or set ALLOW_INSECURE_HTTP=1 to override (not for production).`,
        );
      }
    }
  }

  /**
   * Execute a GraphQL query or mutation.
   *
   * @param {string} queryString - The GraphQL query/mutation string
   * @param {Object} [variables={}] - GraphQL variables
   * @returns {Promise<Object>} The parsed JSON response (contains `data` and optionally `errors`)
   * @throws {Error} On network failure, HTTP error, or GraphQL errors
   */
  async query(queryString, variables = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    let response;
    try {
      response = await fetch(this.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({ query: queryString, variables }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      if (err.name === 'TimeoutError' || err.code === 'UND_ERR_CONNECT_TIMEOUT') {
        throw new Error(`GraphQL request timed out after ${this.timeoutMs}ms — try increasing config.settings.requestTimeoutMs`);
      }
      throw new Error(`GraphQL request failed (network): ${err.message}`);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '(could not read response body)');
      throw new Error(`GraphQL request failed: HTTP ${response.status} ${response.statusText}\n${body}`);
    }

    const json = await response.json();

    if (json.errors) {
      const messages = json.errors.map(e => e.message).join('; ');
      throw new Error(`GraphQL errors: ${messages}`);
    }

    return json;
  }
}
