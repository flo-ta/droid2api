import { isDevMode } from './config.js';

function redactHeaders(headers) {
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [
    name,
    ['authorization', 'x-api-key', 'proxy-authorization'].includes(name.toLowerCase())
      ? '[REDACTED]' : value
  ]));
}

export function logInfo(message, data = null) {
  console.log(`[INFO] ${message}`);
  if (data && isDevMode()) {
    console.log(JSON.stringify(data, null, 2));
  }
}

export function logDebug(message, data = null) {
  if (isDevMode()) {
    console.log(`[DEBUG] ${message}`);
    if (data) {
      console.log(JSON.stringify(data, null, 2));
    }
  }
}

export function logError(message, error = null) {
  console.error(`[ERROR] ${message}`);
  if (error) {
    if (isDevMode()) {
      console.error(error);
    } else {
      console.error(error.message || error);
    }
  }
}

export function logRequest(method, url, headers = null, body = null) {
  if (isDevMode()) {
    console.log(`\n${'='.repeat(80)}`);
    console.log(`[REQUEST] ${method} ${url}`);
    if (headers) {
      console.log('[HEADERS]', JSON.stringify(redactHeaders(headers), null, 2));
    }
    if (body) {
      console.log('[BODY]', JSON.stringify(body, null, 2));
    }
    console.log('='.repeat(80) + '\n');
  } else {
    console.log(`[REQUEST] ${method} ${url}`);
  }
}

export function logResponse(status, headers = null, body = null) {
  if (isDevMode()) {
    console.log(`\n${'-'.repeat(80)}`);
    console.log(`[RESPONSE] Status: ${status}`);
    if (headers) {
      console.log('[HEADERS]', JSON.stringify(redactHeaders(headers), null, 2));
    }
    if (body) {
      console.log('[BODY]', JSON.stringify(body, null, 2));
    }
    console.log('-'.repeat(80) + '\n');
  } else {
    console.log(`[RESPONSE] Status: ${status}`);
  }
}
