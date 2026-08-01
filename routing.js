// Per-service backend routing for the portal.
//
// The Hermes backend is split into one process per app (finance, cases, intake,
// renewals) so a slow call in one cannot stall the others. Each runs on its own
// port on the box.
//
// OFF BY DEFAULT: every prefix resolves to the single hermes API unless its env
// var is set. That is deliberate — the split flips one app at a time, by config,
// and reverts the same way. Setting nothing keeps today's behaviour exactly.
//
//   HERMES_FINANCE_URL=http://rsg-hermes-finance:8801
//   HERMES_CASES_URL=http://rsg-hermes-cases:8802
//   HERMES_INTAKE_URL=http://rsg-hermes-intake:8803
//   HERMES_RENEWALS_URL=http://rsg-hermes-renewals:8804

// Longest prefix wins, so /api/commission-statements resolves before
// /api/commissions would swallow it.
function buildBackends(env) {
  return [
    ['/api/commission-statements', env.HERMES_FINANCE_URL],
    ['/api/commission-rules',      env.HERMES_FINANCE_URL],
    ['/api/commissions',           env.HERMES_FINANCE_URL],
    ['/api/case-templates',        env.HERMES_CASES_URL],
    ['/api/casework',              env.HERMES_CASES_URL],
    ['/api/cases',                 env.HERMES_CASES_URL],
    ['/api/tasks',                 env.HERMES_CASES_URL],
    ['/api/queue',                 env.HERMES_CASES_URL],
    ['/api/pipeline',              env.HERMES_INTAKE_URL],
    ['/api/leads',                 env.HERMES_INTAKE_URL],
    ['/api/intake',                env.HERMES_INTAKE_URL],
    ['/api/renewals',              env.HERMES_RENEWALS_URL],
  ]
    .filter(function (e) { return !!e[1]; })
    .map(function (e) { return [e[0], String(e[1]).replace(/\/+$/, '')]; })
    .sort(function (a, b) { return b[0].length - a[0].length; });
}

// Which backend serves this path. Falls back to the single hermes API, which is
// what every path does until an env var says otherwise.
function makeBackendFor(apiBase, env) {
  const backends = buildBackends(env || {});
  return function backendFor(p) {
    for (const entry of backends) {
      const prefix = entry[0];
      if (p === prefix || p.indexOf(prefix + '/') === 0) return entry[1];
    }
    return apiBase;
  };
}

module.exports = { buildBackends, makeBackendFor };
