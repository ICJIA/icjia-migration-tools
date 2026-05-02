/**
 * @module rest-client
 * @description Thin wrapper around native `fetch` for Strapi 5 REST API calls.
 *
 * Provides GET, POST, PUT, and multipart file upload methods with
 * configurable auth, timeout, and clear error reporting. Used by Phase 4
 * (data loading) and Phase 5 (verification).
 *
 * @example
 *   import { RestClient } from '../lib/rest-client.js';
 *   const client = new RestClient('http://localhost:1338', {
 *     token: 'my-api-token',
 *     timeoutMs: 30000,
 *   });
 *   const articles = await client.get('/api/articles', { 'pagination[pageSize]': 1 });
 *   const created = await client.post('/api/articles', { title: 'Hello' });
 */

import fs from 'fs/promises';
import path from 'path';

/**
 * A REST client that wraps native `fetch` with auth, timeout, and error handling.
 */
export class RestClient {
  /**
   * Create a new REST client.
   *
   * @param {string} baseUrl - Base URL of the Strapi 5 instance (e.g., "http://localhost:1338")
   * @param {Object} [options] - Client options
   * @param {string} [options.token] - Bearer token for Authorization header (omitted if empty/null)
   * @param {number} [options.timeoutMs=30000] - Request timeout in milliseconds
   */
  constructor(baseUrl, options = {}) {
    // Strip trailing slash for consistent path joining
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.token = options.token || null;
    this.timeoutMs = options.timeoutMs || 30000;

    // Warn if sending a token over plaintext HTTP to a non-localhost URL
    if (
      this.token &&
      baseUrl.startsWith('http://') &&
      !baseUrl.includes('localhost') &&
      !baseUrl.includes('127.0.0.1')
    ) {
      console.warn(
        `\x1b[33mWARNING: Sending API token over plaintext HTTP to ${baseUrl}\x1b[0m`,
      );
      console.warn(
        `\x1b[33mUse HTTPS in production to prevent token interception.\x1b[0m`,
      );
    }
  }

  /**
   * Build standard headers for JSON requests.
   *
   * @param {Object} [extra] - Additional headers to merge
   * @returns {Object} Headers object
   * @private
   */
  _headers(extra = {}) {
    const headers = { ...extra };
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }
    return headers;
  }

  /**
   * Perform a GET request with optional query parameters.
   *
   * @param {string} apiPath - API path (e.g., "/api/articles")
   * @param {Object} [params={}] - Query parameters as key-value pairs
   * @returns {Promise<Object>} Parsed JSON response body
   * @throws {Error} On network failure, HTTP error, or timeout
   *
   * @example
   *   const result = await client.get('/api/articles', {
   *     'filters[legacyId][$eq]': '60b8d295f1d2c72a4c9e1234',
   *   });
   */
  async get(apiPath, params = {}) {
    const url = new URL(`${this.baseUrl}${apiPath}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    }

    let response;
    try {
      response = await fetch(url.toString(), {
        method: 'GET',
        headers: this._headers({ 'Content-Type': 'application/json' }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      if (err.name === 'TimeoutError' || err.code === 'UND_ERR_CONNECT_TIMEOUT') {
        throw new Error(`GET ${apiPath} timed out after ${this.timeoutMs}ms`);
      }
      throw new Error(`GET ${apiPath} failed (network): ${err.message}`);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '(could not read response body)');
      throw new Error(`GET ${apiPath} failed: HTTP ${response.status} ${response.statusText}\n${body}`);
    }

    return response.json();
  }

  /**
   * Perform a POST request with a JSON body wrapped in `{ data: ... }`.
   *
   * @param {string} apiPath - API path (e.g., "/api/articles")
   * @param {Object} data - Payload to wrap as `{ data: ... }`
   * @returns {Promise<Object>} Parsed JSON response body
   * @throws {Error} On network failure, HTTP error, or timeout
   *
   * @example
   *   const result = await client.post('/api/articles', {
   *     title: 'New Article',
   *     legacyId: '507f1f77bcf86cd799439011',
   *   });
   */
  async post(apiPath, data) {
    let response;
    try {
      response = await fetch(`${this.baseUrl}${apiPath}`, {
        method: 'POST',
        headers: this._headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ data }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      if (err.name === 'TimeoutError' || err.code === 'UND_ERR_CONNECT_TIMEOUT') {
        throw new Error(`POST ${apiPath} timed out after ${this.timeoutMs}ms`);
      }
      throw new Error(`POST ${apiPath} failed (network): ${err.message}`);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '(could not read response body)');
      throw new Error(`POST ${apiPath} failed: HTTP ${response.status} ${response.statusText}\n${body}`);
    }

    return response.json();
  }

  /**
   * Perform a PUT request with a JSON body wrapped in `{ data: ... }`.
   *
   * @param {string} apiPath - API path (e.g., "/api/articles/abc123")
   * @param {Object} data - Payload to wrap as `{ data: ... }`
   * @returns {Promise<Object>} Parsed JSON response body
   * @throws {Error} On network failure, HTTP error, or timeout
   *
   * @example
   *   const result = await client.put('/api/articles/abc123', {
   *     datasets: { connect: [{ documentId: 'def456' }] },
   *   });
   */
  async put(apiPath, data) {
    let response;
    try {
      response = await fetch(`${this.baseUrl}${apiPath}`, {
        method: 'PUT',
        headers: this._headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ data }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      if (err.name === 'TimeoutError' || err.code === 'UND_ERR_CONNECT_TIMEOUT') {
        throw new Error(`PUT ${apiPath} timed out after ${this.timeoutMs}ms`);
      }
      throw new Error(`PUT ${apiPath} failed (network): ${err.message}`);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '(could not read response body)');
      throw new Error(`PUT ${apiPath} failed: HTTP ${response.status} ${response.statusText}\n${body}`);
    }

    return response.json();
  }

  /**
   * Upload a file via multipart form data to `/api/upload`.
   *
   * @param {string} filePath - Absolute path to the file on disk
   * @param {string} filename - Filename to use in the upload
   * @param {string} mimeType - MIME type of the file (e.g., "image/png")
   * @returns {Promise<Object>} Parsed JSON response (array of uploaded file objects)
   * @throws {Error} On network failure, HTTP error, or timeout
   *
   * @example
   *   const result = await client.upload('/tmp/chart.png', 'chart.png', 'image/png');
   *   console.log(result[0].id); // Strapi 5 media ID
   */
  async upload(filePath, filename, mimeType) {
    const fileBuffer = await fs.readFile(filePath);
    const blob = new Blob([fileBuffer], { type: mimeType });

    const formData = new FormData();
    formData.append('files', blob, filename);

    const headers = {};
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }
    // Do NOT set Content-Type — fetch will set it with the boundary

    let response;
    try {
      response = await fetch(`${this.baseUrl}/api/upload`, {
        method: 'POST',
        headers,
        body: formData,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      if (err.name === 'TimeoutError' || err.code === 'UND_ERR_CONNECT_TIMEOUT') {
        throw new Error(`Upload ${filename} timed out after ${this.timeoutMs}ms`);
      }
      throw new Error(`Upload ${filename} failed (network): ${err.message}`);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '(could not read response body)');
      throw new Error(`Upload ${filename} failed: HTTP ${response.status} ${response.statusText}\n${body}`);
    }

    return response.json();
  }
}
