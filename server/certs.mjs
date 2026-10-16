// Self-signed TLS certificate management for PromptForge.
//
// Generates an EC P-256 self-signed cert on first boot if none exists, so the
// app is reachable over https:// out of the box. Custom certs can be dropped in
// via config (server.tls.cert / server.tls.key) and override generation.
//
// The generated cert is valid for 10 years and covers localhost plus common
// internal hostnames. It is written to data/certs/ which is already a persistent
// volume mount, so it survives container rebuilds.

import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

// Under the configured data directory (data/ unless PROMPTFORGE_DATA_DIR moves
// it), so a test run never writes keys into a real install. Set by
// loadTlsCredentials before anything reads them.
let CERT_DIR = 'data/certs';
let CERT_FILE = path.join(CERT_DIR, 'server.crt');
let KEY_FILE = path.join(CERT_DIR, 'server.key');
const CN = 'PromptForge';
// SANs covering localhost and common internal access patterns. Clients that
// connect by a different name will see a hostname mismatch warning, which is
// expected for a self-signed cert.
const SAN_NAMES = [
  'localhost',
  '127.0.0.1',
  '::1',
  'promptforge',
  'promptforge.local',
];

function sanExtension() {
  return SAN_NAMES.map((n) => `DNS:${n}`).join(',');
}

/**
 * Generate a self-signed EC P-256 certificate using openssl.
 * Returns true if generation succeeded, false otherwise.
 */
export function generateSelfSignedCert() {
  try {
    mkdirSync(CERT_DIR, { recursive: true });

    const san = sanExtension();
    // Two steps to avoid process substitution (not available in dash/sh).
    // Step 1: generate the EC P-256 key.
    execSync(
      `openssl ecparam -name prime256v1 -genkey -noout -out "${KEY_FILE}"`,
      { stdio: 'pipe', timeout: 10000 }
    );
    // Step 2: create the self-signed cert with SANs.
    execSync(
      `openssl req -x509 -new -key "${KEY_FILE}" -out "${CERT_FILE}" -days 3650 -nodes ` +
        `-subj "/CN=${CN}/O=PromptForge/C=DE" ` +
        `-addext "subjectAltName=${san}"`,
      { stdio: 'pipe', timeout: 10000 }
    );

    console.log(`[certs] generated self-signed EC P-256 cert (${CN}) valid 10 years`);
    return true;
  } catch (err) {
    console.error('[certs] failed to generate self-signed cert:', err.message);
    return false;
  }
}

/**
 * Load TLS credentials. Priority:
 *   1. Custom certs from config (server.tls.cert / server.tls.key)
 *   2. Existing generated certs in data/certs/
 *   3. Generate new self-signed cert
 * Returns { cert, key } PEM strings, or null if no TLS is possible.
 */
export function loadTlsCredentials(config) {
  CERT_DIR = path.join(config.paths?.data ?? 'data', 'certs');
  CERT_FILE = path.join(CERT_DIR, 'server.crt');
  KEY_FILE = path.join(CERT_DIR, 'server.key');
  const tls = config.server?.tls ?? {};

  // Custom certs override everything.
  if (tls.cert && tls.key) {
    try {
      return {
        cert: readFileSync(tls.cert, 'utf8'),
        key: readFileSync(tls.key, 'utf8'),
      };
    } catch (err) {
      console.error(`[certs] failed to load custom certs (${tls.cert}):`, err.message);
    }
  }

  // Use existing generated certs.
  if (existsSync(CERT_FILE) && existsSync(KEY_FILE)) {
    try {
      return {
        cert: readFileSync(CERT_FILE, 'utf8'),
        key: readFileSync(KEY_FILE, 'utf8'),
      };
    } catch (err) {
      console.error('[certs] failed to read existing certs:', err.message);
    }
  }

  // Generate new.
  if (generateSelfSignedCert()) {
    try {
      return {
        cert: readFileSync(CERT_FILE, 'utf8'),
        key: readFileSync(KEY_FILE, 'utf8'),
      };
    } catch (err) {
      console.error('[certs] failed to read generated certs:', err.message);
    }
  }

  return null;
}
