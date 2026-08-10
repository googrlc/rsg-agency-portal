// Per-service backend routing for the portal.
//
// The Hermes backend is split into one process per app (finance, cases, intake,
// renewals, crm) so a slow call in one cannot stall the others. Each runs on its
// own port on the box.
//
// OFF BY DEFAULT: every prefix resolves to the single hermes API unless its env
// var is set. That is deliberate — the split flips one app at a time, by config,
// and reverts the same way. Setting nothing keeps today's behaviour exactly.
//
//   HERMES_FINANCE_URL=http://rsg-hermes-finance:8801
//   HERMES_CASES_URL=http://rsg-hermes-cases:8802
//   HERMES_INTAKE_URL=http://rsg-hermes-intake:8803
//   HERMES_RENEWALS_URL=http://rsg-hermes-renewals:8804
//   HERMES_CRM_URL=http://rsg-hermes-crm:8805

// Longest prefix wins, so /api/commission-statements resolves before
// /api/commissions would swallow it.
function buildBackends(env) {
  // CRM carve-out. Until HERMES_CRM_URL is set, every one of these rows either
  // filters out (falls through to the hub) or keeps its previous target, so
  // setting nothing is still an exact no-op.
  //
  // Pipeline and leads used to ride the Hermes intake split. They now follow the
  // CRM when it is split out, and keep falling back to the intake split (then the
  // hub) when it is not — `crm || HERMES_INTAKE_URL` — so no live deployment that
  // runs the intake split without a CRM is repointed.
  const crm = env.HERMES_CRM_URL;
  const crmOrIntake = crm || env.HERMES_INTAKE_URL;
  return [
    ['/api/commission-statements', env.HERMES_FINANCE_URL],
    ['/api/commission-rules',      env.HERMES_FINANCE_URL],
    ['/api/commissions',           env.HERMES_FINANCE_URL],
    ['/api/case-templates',        env.HERMES_CASES_URL],
    ['/api/casework',              env.HERMES_CASES_URL],
    ['/api/cases',                 env.HERMES_CASES_URL],
    ['/api/tasks',                 env.HERMES_CASES_URL],
    ['/api/queue',                 env.HERMES_CASES_URL],
    // CRM book. clients/policies/quotes and the CRM stat header were absent from
    // the table before (so they resolved to the hub); with HERMES_CRM_URL unset
    // they still filter out and resolve to the hub.
    ['/api/clients',               crm],
    ['/api/policies',              crm],
    ['/api/quotes',                crm],
    ['/api/workspace-stats',       crm],
    // Pipeline deals. server.js rewrites /api/pipeline reads to /api/opportunities
    // before host selection, so BOTH prefixes must point at the CRM for the board
    // and the deal records to resolve to the same instance. /api/opportunities was
    // not in the table before (it resolved to the hub), so it takes the CRM only —
    // no intake fallback — to preserve that.
    ['/api/opportunities',         crm],
    ['/api/pipeline',              crmOrIntake],
    ['/api/leads',                 crmOrIntake],
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
