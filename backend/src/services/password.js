const crypto = require('crypto');

/**
 * Password hashing, on Node's own crypto rather than a dependency.
 *
 * bcrypt and argon2 are the usual answers and both are native modules — they
 * compile on install, which is a build toolchain in the Docker image and a
 * class of deploy failure this stack does not otherwise have. scrypt ships with
 * Node, is memory-hard in the way that matters against GPU cracking, and is
 * what the password-hashing literature recommends when argon2 is unavailable.
 *
 * The parameters below are the interactive-login end of the scale: about 100ms
 * per hash on a modest VPS. That is slow enough to make offline cracking
 * expensive and fast enough that nobody notices signing in.
 */

// N: CPU/memory cost. Doubling it doubles both. 2^15 needs ~32MB per hash,
// which is the point of scrypt — an attacker cannot trade memory away.
const COST = 32768;
const BLOCK_SIZE = 8;
const PARALLELISM = 1;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

// scrypt refuses to allocate past this, and the default ceiling sits BELOW what
// N=32768 needs — leave it out and every hash throws "Invalid scrypt params",
// which reads like a bad password rather than a missing option.
const MAX_MEMORY = 64 * 1024 * 1024;

const KEY_OPTIONS = { N: COST, r: BLOCK_SIZE, p: PARALLELISM, maxmem: MAX_MEMORY };

function derive(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, KEY_LENGTH, KEY_OPTIONS, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

/**
 * `scrypt$N$r$p$salt$hash`, all base64 after the parameters.
 *
 * The parameters travel WITH the hash rather than being read from the
 * constants above at verify time. Raising COST later is then a change that
 * only affects new passwords: every hash already in the table still says how
 * it was made, and still verifies. Read the cost from a constant instead and
 * the day you raise it is the day every existing user is locked out.
 */
async function hash(password) {
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('A password is required.');
  }
  const salt = crypto.randomBytes(SALT_LENGTH);
  const key = await derive(password, salt);
  return [
    'scrypt', COST, BLOCK_SIZE, PARALLELISM,
    salt.toString('base64'), key.toString('base64'),
  ].join('$');
}

/**
 * Whether a password matches an encoded hash.
 *
 * Returns false rather than throwing on a malformed hash: a corrupt row is a
 * failed login for that one account, not a 500 that tells an attacker they
 * found something interesting.
 */
async function verify(password, encoded) {
  if (typeof password !== 'string' || typeof encoded !== 'string') return false;

  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const [, costRaw, blockRaw, parRaw, saltRaw, keyRaw] = parts;
  const N = parseInt(costRaw, 10);
  const r = parseInt(blockRaw, 10);
  const p = parseInt(parRaw, 10);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;

  let salt;
  let expected;
  try {
    salt = Buffer.from(saltRaw, 'base64');
    expected = Buffer.from(keyRaw, 'base64');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  let actual;
  try {
    actual = await new Promise((resolve, reject) => {
      crypto.scrypt(password, salt, expected.length, { N, r, p, maxmem: MAX_MEMORY },
        (err, key) => (err ? reject(err) : resolve(key)));
    });
  } catch {
    return false;
  }

  // timingSafeEqual, not ===. Comparing two buffers with === or a loop that
  // stops at the first difference leaks how much of the hash matched through
  // how long the comparison took, which is enough to reconstruct it byte by
  // byte given enough attempts. It also throws on a length mismatch, hence
  // the guard.
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

module.exports = { hash, verify };
