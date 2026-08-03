// The cases split changes more than which host a path goes to: the cases
// service spells tasks differently from the hub. These lock the shape on both
// sides of the flip, because getting it wrong is silent — a task list that
// quietly grows cancelled work, or a Complete button that 404s.
//
import assert from 'node:assert';

const CASES = 'http://rsg-hermes-cases:8802';

let n = 0;
const check = (name, fn) => { fn(); n++; console.log('  ok  ' + name); };

// server.js starts a listener on import, so probe the routing decisions through
// the exported table instead of standing the whole thing up.
const { makeBackendFor } = await import('../routing.js');

check('unflipped, tasks stay on the hub path', () => {
  const backendFor = makeBackendFor('http://hub:8787', {});
  assert.strictEqual(backendFor('/api/command-center/tasks'), 'http://hub:8787');
});

check('flipped, the bare tasks path reaches the cases service', () => {
  const backendFor = makeBackendFor('http://hub:8787', { HERMES_CASES_URL: CASES });
  assert.strictEqual(backendFor('/api/tasks'), CASES);
});

// The bug this exists to prevent: routing.js matches a bare prefix, so a path
// carrying its query cannot be handed to backendFor. If someone "simplifies"
// EXTRA_QUERY back into ROUTES, tasks silently fall through to the hub.
check('a path with a query matches no prefix and falls back to the hub', () => {
  const backendFor = makeBackendFor('http://hub:8787', { HERMES_CASES_URL: CASES });
  assert.strictEqual(backendFor('/api/tasks?open_only=true'), 'http://hub:8787');
});

check('task sub-paths follow tasks to the cases service', () => {
  const backendFor = makeBackendFor('http://hub:8787', { HERMES_CASES_URL: CASES });
  assert.strictEqual(backendFor('/api/tasks/0e5b1f5e-1f2a-4c3d-9e8f-1a2b3c4d5e6f'), CASES);
});

check('cases and its sub-paths follow too', () => {
  const backendFor = makeBackendFor('http://hub:8787', { HERMES_CASES_URL: CASES });
  assert.strictEqual(backendFor('/api/cases'), CASES);
  assert.strictEqual(backendFor('/api/cases/abc/progress'), CASES);
  assert.strictEqual(backendFor('/api/case-templates'), CASES);
  assert.strictEqual(backendFor('/api/casework/run'), CASES);
  assert.strictEqual(backendFor('/api/queue/failed'), CASES);
});

check('flipping cases leaves every other app on the hub', () => {
  const backendFor = makeBackendFor('http://hub:8787', { HERMES_CASES_URL: CASES });
  for (const p of ['/api/clients', '/api/policies', '/api/renewals', '/api/commissions',
                   '/api/workspace-stats', '/api/leads']) {
    assert.strictEqual(backendFor(p), 'http://hub:8787', p + ' must not move');
  }
});

console.log('\n' + n + ' passed');
