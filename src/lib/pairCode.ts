// Pair-code resolution against the always-on hub directory.
//
// The desktop publishes its QR's query params under the 6-digit PIN it shows
// (see Desktop remote/mod.rs get_pair_qr_info -> POST /api/pair-code). A
// phone that cannot scan the QR types the code instead; this module turns it
// into the same /pair/?... route the scanner produces, so both entry methods
// share one pairing implementation.

// Hardcoded to match the desktop's PAIR_DIRECTORY_URL.
const PAIR_DIRECTORY_URL = 'https://cloud.itspotatotime.xyz';

export interface PairCodeResult {
  code: string;
  query: string;
  server_id: string;
  server_name: string;
}

export class PairCodeError extends Error {
  kind: 'invalid_code' | 'unknown_or_expired' | 'rate_limited' | 'network';
  constructor(kind: PairCodeError['kind'], message: string) {
    super(message);
    this.kind = kind;
  }
}

/** Strictly 6 digits, matching what the desktop generates. */
export function normalizeCode(raw: string): string | null {
  const code = raw.replace(/\D/g, '').slice(0, 6);
  return code.length === 6 ? code : null;
}

/**
 * Resolve a code into a /pair/ redirect target. Throws PairCodeError with a
 * user-actionable kind on failure.
 */
export async function resolvePairCode(code: string): Promise<string> {
  let normalized: string;
  try {
    normalized = normalizeCode(code) ?? '';
  } catch {
    normalized = '';
  }
  if (!normalized) {
    throw new PairCodeError('invalid_code', 'Enter the 6-digit code shown on the desktop.');
  }

  let resp: Response;
  try {
    resp = await fetch(`${PAIR_DIRECTORY_URL}/api/pair-code/${normalized}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
  } catch (e: any) {
    throw new PairCodeError(
      'network',
      `Could not reach ${PAIR_DIRECTORY_URL.replace('https://', '')}. Use the QR code instead.`,
    );
  }

  if (resp.status === 404) {
    throw new PairCodeError(
      'unknown_or_expired',
      'That code is not active. Generate a new code on the desktop and try again.',
    );
  }
  if (resp.status === 429) {
    throw new PairCodeError('rate_limited', 'Too many attempts. Wait a minute and try again.');
  }
  if (!resp.ok) {
    throw new PairCodeError('network', `Pairing service error (${resp.status}).`);
  }

  const payload = await resp.json();
  if (!payload?.ok || typeof payload.query !== 'string' || !payload.query) {
    throw new PairCodeError('network', 'Pairing service returned an invalid response.');
  }
  return `/pair/?${payload.query}`;
}
