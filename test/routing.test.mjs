// Routing table checks. The property that matters most is the first one: with
// no env set this change must be a no-op, or merging it silently repoints
// production traffic.
import { makeBackendFor } from '../routing.js';
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

// ── CRM carve-out (HERMES_CRM_URL) ──────────────────────────────────────────

check('the CRM split moves the client book, pipeline and leads together', () => {
  const CRM = 'http://rsg-hermes-crm:8805';
  const b = makeBackendFor(HUB, { HERMES_CRM_URL: CRM });
  for (const p of ['/api/clients', '/api/policies', '/api/quotes',
                   '/api/workspace-stats', '/api/opportunities',
                   '/api/pipeline', '/api/leads']) {
    assert.equal(b(p), CRM, p + ' did not follow the CRM split');
  }
  // Everything else stays on the hub.
  assert.equal(b('/api/renewals'), HUB, 'renewals moved when only CRM was flipped');
  assert.equal(b('/api/cases'), HUB, 'cases moved when only CRM was flipped');
  assert.equal(b('/api/commissions'), HUB, 'finance moved when only CRM was flipped');
});

check('CRM sub-paths follow their prefix (client 360, push-to-ams)', () => {
  const CRM = 'http://crm:8805';
  const b = makeBackendFor(HUB, { HERMES_CRM_URL: CRM });
  assert.equal(b('/api/clients/abc-123'), CRM);
  assert.equal(b('/api/policies/abc-123/push-to-ams'), CRM);
  assert.equal(b('/api/opportunities/xyz/stage'), CRM);
});

check('leads and pipeline prefer the CRM over the intake split', () => {
  const CRM = 'http://crm:8805', INTAKE = 'http://intake:8803';
  const b = makeBackendFor(HUB, { HERMES_CRM_URL: CRM, HERMES_INTAKE_URL: INTAKE });
  assert.equal(b('/api/leads'), CRM, 'leads should follow the CRM once it exists');
  assert.equal(b('/api/pipeline'), CRM, 'pipeline should follow the CRM once it exists');
  // The intake gateway split itself still owns /api/intake.
  assert.equal(b('/api/intake'), INTAKE, 'intake left the intake split');
});

check('without a CRM, leads and pipeline still follow the intake split', () => {
  // Non-breaking guard: a deployment running the intake split but no CRM must
  // see leads and pipeline exactly where they were before this change.
  const INTAKE = 'http://intake:8803';
  const b = makeBackendFor(HUB, { HERMES_INTAKE_URL: INTAKE });
  assert.equal(b('/api/leads'), INTAKE);
  assert.equal(b('/api/pipeline'), INTAKE);
  // /api/opportunities was never on the intake split — it stayed on the hub.
  assert.equal(b('/api/opportunities'), HUB, 'opportunities drifted onto the intake split');
  assert.equal(b('/api/clients'), HUB, 'the client book drifted off the hub');
});

check('opportunities takes the CRM only, never the intake split', () => {
  const CRM = 'http://crm:8805';
  const b = makeBackendFor(HUB, { HERMES_CRM_URL: CRM });
  assert.equal(b('/api/opportunities'), CRM);
});

check('the CRM prefix must not match a longer unrelated word', () => {
  // /api/leads must not capture /api/leadsource; /api/clients not /api/clientsx
  const b = makeBackendFor(HUB, { HERMES_CRM_URL: 'http://crm:8805' });
  assert.equal(b('/api/leadsource'), HUB);
  assert.equal(b('/api/clientsx'), HUB);
});

console.log(`\n${n} passed`);
