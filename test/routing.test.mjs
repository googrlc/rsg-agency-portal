// Routing table checks. The property that matters most is the first one: with
// no env set this change must be a no-op, or merging it silently repoints
// production traffic.
import { makeBackendFor } from './routing.js';
import assert from 'node:assert';

const HUB = 'http://rsg-hermes-api:8787';
const ALL = ['/api/cases', '/api/tasks', '/api/renewals', '/api/commissions',
             '/api/commission-statements', '/api/leads', '/api/clients',
             '/api/policies', '/api/opportunities', '/api/documents'];
let n = 0;
const check = (name, fn) => { fn(); n++; console.log('  ok  ' + name); };

check('with nothing set, every path still goes to the hub', () => {
  const b = makeBackendFor(HUB, {});
  for (const p of ALL) assert.equal(b(p), HUB, p + ' drifted off the hub');
});

check('flipping one app moves only that app', () => {
  const b = makeBackendFor(HUB, { HERMES_CASES_URL: 'http://rsg-hermes-cases:8802' });
  assert.equal(b('/api/cases'), 'http://rsg-hermes-cases:8802');
  assert.equal(b('/api/tasks'), 'http://rsg-hermes-cases:8802');
  assert.equal(b('/api/renewals'), HUB, 'renewals moved when only cases was flipped');
  assert.equal(b('/api/clients'), HUB, 'a hub route moved');
});

check('sub-paths follow their prefix', () => {
  const b = makeBackendFor(HUB, { HERMES_CASES_URL: 'http://c:8802' });
  assert.equal(b('/api/cases/abc-123/documents'), 'http://c:8802');
  assert.equal(b('/api/tasks/xyz/push-to-ams'), 'http://c:8802');
});

check('a longer prefix is not swallowed by a shorter one', () => {
  // /api/commissions must not capture /api/commission-statements
  const b = makeBackendFor(HUB, { HERMES_FINANCE_URL: 'http://f:8801' });
  assert.equal(b('/api/commission-statements'), 'http://f:8801');
  assert.equal(b('/api/commissions'), 'http://f:8801');
});

check('a prefix must not match a longer unrelated word', () => {
  // /api/cases must not capture a hypothetical /api/casesomething
  const b = makeBackendFor(HUB, { HERMES_CASES_URL: 'http://c:8802' });
  assert.equal(b('/api/casesomething'), HUB);
});

check('trailing slashes on the base are trimmed', () => {
  const b = makeBackendFor(HUB, { HERMES_CASES_URL: 'http://c:8802/' });
  assert.equal(b('/api/cases'), 'http://c:8802');
});

console.log(`\n${n} passed`);
