(function initPortalApiClient(global) {
  const inFlightByKey = new Map();
  const abortByKey = new Map();

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function createRequestId() {
    try {
      if (global.crypto && typeof global.crypto.randomUUID === 'function') {
        return global.crypto.randomUUID();
      }
    } catch (_) {
      // no-op
    }
    return `req_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }

  function readCsrfToken() {
    const match = document.cookie.match(/(?:^|;\s*)_csrf=([^;]*)/);
    return match ? decodeURIComponent(match[1]) : '';
  }

  function toVersionedApiPath(url) {
    const raw = String(url || '');
    if (!raw.startsWith('/api/')) return raw;
    if (raw.startsWith('/api/v1/')) return raw;
    return `/api/v1/${raw.slice('/api/'.length)}`;
  }

  function mergeSignals(primary, secondary) {
    if (!secondary) return primary;
    if (!primary) return secondary;
    const controller = new AbortController();
    const forward = (event) => {
      const source = event && event.target;
      const reason = source && Object.prototype.hasOwnProperty.call(source, 'reason')
        ? source.reason
        : undefined;
      if (reason !== undefined) controller.abort(reason);
      else controller.abort(new DOMException('Request canceled', 'AbortError'));
    };
    primary.addEventListener('abort', forward, { once: true });
    secondary.addEventListener('abort', forward, { once: true });
    return controller.signal;
  }

  function shouldRetryResponse(response) {
    return response.status === 429 || response.status >= 500;
  }

  function shouldRetryError(error) {
    if (!error) return false;
    if (error.name === 'AbortError' || error.name === 'TimeoutError' || error.name === 'CanceledError') return false;
    return true;
  }

  async function request(url, options = {}) {
    const method = String(options.method || 'GET').toUpperCase();
    const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 30000;
    const retries = Number.isFinite(options.retries) ? options.retries : 2;
    const dedupeEnabled = options.dedupe !== false && method === 'GET';
    const dedupeKey = options.dedupeKey || `${method}:${toVersionedApiPath(url)}`;
    const cancelKey = options.cancelKey || '';
    const cancelPrevious = !!options.cancelPrevious;

    if (cancelPrevious && cancelKey) {
      const previous = abortByKey.get(cancelKey);
      if (previous) previous.abort(new DOMException('Canceled by newer request', 'CanceledError'));
    }

    if (dedupeEnabled && inFlightByKey.has(dedupeKey)) {
      return inFlightByKey.get(dedupeKey).then(response => response.clone());
    }

    const baseHeaders = { ...(options.headers || {}) };
    if (!baseHeaders['X-Request-ID']) baseHeaders['X-Request-ID'] = createRequestId();
    if (method !== 'GET' && method !== 'HEAD') {
      const csrf = readCsrfToken();
      if (csrf && !baseHeaders['X-CSRF-Token']) baseHeaders['X-CSRF-Token'] = csrf;
    }

    const fetchOptions = { ...options };
    delete fetchOptions.timeoutMs;
    delete fetchOptions.retries;
    delete fetchOptions.dedupe;
    delete fetchOptions.dedupeKey;
    delete fetchOptions.cancelKey;
    delete fetchOptions.cancelPrevious;

    const run = async () => {
      for (let attempt = 0; attempt <= retries; attempt++) {
        const controller = new AbortController();
        let timedOut = false;
        const timeoutId = setTimeout(() => {
          timedOut = true;
          controller.abort(new DOMException(`Request timed out after ${timeoutMs} ms`, 'TimeoutError'));
        }, timeoutMs);
        const signal = mergeSignals(controller.signal, fetchOptions.signal);
        if (cancelKey) abortByKey.set(cancelKey, controller);
        try {
          const response = await fetch(toVersionedApiPath(url), {
            ...fetchOptions,
            method,
            headers: baseHeaders,
            signal,
            credentials: fetchOptions.credentials || 'same-origin',
          });
          clearTimeout(timeoutId);
          if (attempt < retries && shouldRetryResponse(response)) {
            await sleep(250 * (attempt + 1));
            continue;
          }
          return response;
        } catch (error) {
          clearTimeout(timeoutId);
          if (timedOut) {
            const timeoutError = new Error(`Request timed out after ${Math.round(timeoutMs / 1000)}s. Please retry.`);
            timeoutError.name = 'TimeoutError';
            if (attempt < retries && shouldRetryError(timeoutError)) {
              await sleep(250 * (attempt + 1));
              continue;
            }
            throw timeoutError;
          }
          if (error && (error.name === 'AbortError' || error.name === 'CanceledError')) {
            const msg = String(error.message || '').trim();
            const pretty = (!msg || /without reason/i.test(msg))
              ? 'Request was canceled. Please retry.'
              : msg;
            const abortError = new Error(pretty);
            abortError.name = error.name || 'AbortError';
            throw abortError;
          }
          if (attempt < retries && shouldRetryError(error)) {
            await sleep(250 * (attempt + 1));
            continue;
          }
          throw error;
        } finally {
          if (cancelKey) {
            const stored = abortByKey.get(cancelKey);
            if (stored === controller) abortByKey.delete(cancelKey);
          }
        }
      }
      throw new Error('Request failed');
    };

    const promise = run();
    if (dedupeEnabled) inFlightByKey.set(dedupeKey, promise);
    try {
      const response = await promise;
      return response.clone();
    } finally {
      if (dedupeEnabled) inFlightByKey.delete(dedupeKey);
    }
  }

  function createStore(initialState = {}) {
    let state = { ...(initialState || {}) };
    const listeners = new Set();
    return {
      getState() {
        return state;
      },
      setState(next, meta = '') {
        const partial = typeof next === 'function' ? next(state) : next;
        if (!partial || typeof partial !== 'object') return state;
        state = { ...state, ...partial };
        listeners.forEach(listener => {
          try {
            listener(state, meta);
          } catch (_) {
            // ignore listener errors
          }
        });
        return state;
      },
      subscribe(listener) {
        if (typeof listener !== 'function') return () => {};
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
  }

  global.tcApi = {
    request,
    toVersionedApiPath,
    createStore,
  };
})(window);
