// Unified workspace catalog. Each service remains independently deployed;
// the portal owns only discovery, health visibility, and browser-safe links.

function clean(value) {
  return value ? String(value).replace(/\/+$/, '') : '';
}

function serviceCatalog(env) {
  env = env || {};
  const hermes = clean(env.HERMES_API_URL || 'http://rsg-hermes-api:8787');
  const cases = clean(env.HERMES_CASES_URL);
  const renewals = clean(env.HERMES_RENEWALS_URL);
  const carrier = clean(env.CARRIERHUB_URL || 'http://172.17.0.1:3200');
  const intake = clean(env.INTAKE_GATEWAY_URL || 'http://rsg-intake-gate:8787');
  const commission = clean(env.COMMISSION_TRACKER_URL || 'http://172.17.0.1:3300');

  return [
    { id:'hermes', name:'CRM & Hermes', repo:'googrlc/rsg-hermes', workspace:'crm',
      mode:'native', healthUrl:hermes + '/api/hermes/sync-health', auth:'hermes' },
    { id:'renewals', name:'Renewals', repo:'googrlc/rsg-hermes', workspace:'renewals',
      mode:renewals ? 'service' : 'via Hermes', healthUrl:renewals ? renewals + '/health' : hermes + '/api/hermes/sync-health', auth:'hermes' },
    { id:'cases', name:'Cases & Tasks', repo:'googrlc/rsg-hermes', workspace:'cases',
      mode:cases ? 'service' : 'via Hermes', healthUrl:cases ? cases + '/health' : hermes + '/api/hermes/sync-health', auth:'hermes' },
    { id:'carrier', name:'Carrier Hub', repo:'googrlc/rsg-carrierhub', workspace:'carrier',
      mode:'embedded app', healthUrl:carrier + '/api/health', auth:'none' },
    { id:'intake', name:'Intake', repo:'googrlc/rsg-cptintake', workspace:'intake',
      mode:'same-origin app', healthUrl:intake + '/', auth:'intake' },
    { id:'finance', name:'Commission Tracker', repo:'googrlc/rsg-commission-tracker', workspace:'finance',
      mode:'embedded app', healthUrl:commission + '/api/health', auth:'none' },
    { id:'nextcloud', name:'Nextcloud', repo:null, workspace:'storage',
      mode:'secure external app', healthUrl:null, auth:'external' },
  ];
}

function publicService(service, probe) {
  return {
    id: service.id,
    name: service.name,
    repo: service.repo,
    workspace: service.workspace,
    mode: service.mode,
    status: probe.status,
    detail: probe.detail,
  };
}

module.exports = { serviceCatalog, publicService };
