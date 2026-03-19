/**
 * utils/http.js — Lightweight HTTPS helpers
 * Used by auth (Google SSO) and connector sync functions.
 * Avoids extra npm dependencies by using Node's built-in https module.
 */
const https = require('https');
const qs    = require('querystring');

/**
 * HTTPS GET — returns parsed JSON
 */
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

/**
 * HTTPS POST with URL-encoded body — returns parsed JSON
 * Used for Google OAuth token exchange
 */
function httpsPost(hostname, path, body) {
  return new Promise((resolve, reject) => {
    const postData = qs.stringify(body);
    const req = https.request(
      {
        hostname, path, method: 'POST',
        headers: {
          'Content-Type':   'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(postData),
        },
      },
      (res) => {
        let data = '';
        res.on('data', d => data += d);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
        });
      }
    );
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

/**
 * HTTPS GET — returns raw string + respects custom headers
 * Used by connector sync functions (GitHub, Slack, Google Workspace)
 */
function apiGet(url, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const opts = {
      hostname: parsed.hostname,
      path:     parsed.pathname + (parsed.search || ''),
      method:   'GET',
      headers:  { 'User-Agent': 'TerzoCloud/1.0', ...extraHeaders },
    };
    const req = https.request(opts, r => {
      let data = '';
      r.on('data', c => data += c);
      r.on('end', () => {
        if (r.statusCode >= 400) reject(new Error(`HTTP ${r.statusCode}: ${data.substring(0, 300)}`));
        else resolve(data);
      });
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * HTTPS POST — returns raw string + respects custom headers
 * Used by connector invite / sync functions
 */
function apiPost(hostname, path, body, extraHeaders = {}) {
  const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const opts = {
      hostname, path, method: 'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
        'User-Agent':     'TerzoCloud/1.0',
        ...extraHeaders,
      },
    };
    const req = https.request(opts, r => {
      let data = '';
      r.on('data', c => data += c);
      r.on('end', () => {
        if (r.statusCode >= 400) reject(new Error(`HTTP ${r.statusCode}: ${data.substring(0, 300)}`));
        else resolve(data);
      });
    });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

function apiPostForm(hostname, path, body, extraHeaders = {}) {
  const bodyStr = typeof body === 'string' ? body : qs.stringify(body);
  return new Promise((resolve, reject) => {
    const opts = {
      hostname, path, method: 'POST',
      headers: {
        'Content-Type':   'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(bodyStr),
        'User-Agent':     'TerzoCloud/1.0',
        ...extraHeaders,
      },
    };
    const req = https.request(opts, r => {
      let data = '';
      r.on('data', c => data += c);
      r.on('end', () => {
        if (r.statusCode >= 400) reject(new Error(`HTTP ${r.statusCode}: ${data.substring(0, 300)}`));
        else resolve(data);
      });
    });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

module.exports = { httpsGet, httpsPost, apiGet, apiPost, apiPostForm };
