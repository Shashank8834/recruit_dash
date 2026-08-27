const test = require('node:test');
const assert = require('node:assert');
const password = require('../src/services/password');
const { readCookie } = require('../src/middleware/auth');

/**
 * What stands between this dashboard and anyone who finds the port. The rest
 * of the auth path needs a database; these are the pieces that decide whether
 * a wrong password is refused and a session cookie is read at all.
 */

test('a password verifies against its own hash and nothing else', async () => {
  const hash = await password.hash('correct horse battery staple');
  assert.equal(await password.verify('correct horse battery staple', hash), true);
  assert.equal(await password.verify('Correct horse battery staple', hash), false);
  assert.equal(await password.verify('', hash), false);
});

test('the same password hashes differently every time', async () => {
  // Per-password salt. Without it, two people who choose the same password have
  // the same hash — which says so on the face of the table, and makes one
  // precomputed list of common passwords work against every row at once.
  const a = await password.hash('the same password');
  const b = await password.hash('the same password');
  assert.notEqual(a, b);
  assert.equal(await password.verify('the same password', a), true);
  assert.equal(await password.verify('the same password', b), true);
});

test('the cost parameters travel with the hash', async () => {
  // Read from the encoded string rather than from a constant, so raising the
  // cost later does not invalidate every password already stored.
  const hash = await password.hash('whatever');
  const [scheme, N, r, p] = hash.split('$');
  assert.equal(scheme, 'scrypt');
  assert.ok(Number(N) >= 16384, 'cost should be at least 2^14');
  assert.ok(Number(r) > 0 && Number(p) > 0);
});

test('a hash made at a lower cost still verifies', async () => {
  // The upgrade path, exercised directly: a hash carrying different parameters
  // than the current constants must not lock its owner out.
  const legacy = 'scrypt$16384$8$1$' +
    Buffer.from('sixteen-byte-slt').toString('base64') + '$';
  const crypto = require('crypto');
  const key = crypto.scryptSync('legacy pass', Buffer.from('sixteen-byte-slt'), 64,
    { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const encoded = legacy + key.toString('base64');
  assert.equal(await password.verify('legacy pass', encoded), true);
  assert.equal(await password.verify('wrong', encoded), false);
});

test('a malformed hash is a failed login, not a crash', async () => {
  // A corrupt row should cost that one account a sign-in, not 500 the endpoint
  // and advertise that something unusual is there.
  for (const bad of ['', 'not-a-hash', 'scrypt$$$$', 'bcrypt$1$2$3$4$5',
                     'scrypt$x$8$1$c2FsdA==$aGFzaA==', 'scrypt$32768$8$1$$']) {
    assert.equal(await password.verify('anything', bad), false, `should reject: ${bad}`);
  }
  assert.equal(await password.verify('anything', null), false);
  assert.equal(await password.verify(null, 'anything'), false);
});

test('the session cookie is read out of a crowded header', () => {
  const req = (cookie) => ({ headers: { cookie } });
  assert.equal(
    readCookie(req('darkMode=true; rd_session=abc123; other=x'), 'rd_session'),
    'abc123'
  );
  // A name that merely ENDS with the one we want is a different cookie. Matched
  // by substring, "evil_rd_session" would be accepted as the session.
  assert.equal(readCookie(req('evil_rd_session=attacker'), 'rd_session'), null);
  assert.equal(readCookie(req(''), 'rd_session'), null);
  assert.equal(readCookie({ headers: {} }, 'rd_session'), null);
});

test('a malformed cookie value does not throw', () => {
  // A stray % is not valid percent-encoding, and decodeURIComponent throws on
  // it. Unhandled, that is a 500 on EVERY request until the browser is cleared.
  const req = { headers: { cookie: 'rd_session=%E0%A4%A' } };
  assert.equal(readCookie(req, 'rd_session'), null);
});
