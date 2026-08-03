import services from '../services.js';
import assert from 'node:assert';

const { serviceCatalog, publicService } = services;
const catalog = serviceCatalog({ HERMES_API_URL:'http://hub:8787' });

assert.deepEqual(catalog.map(s => s.id),
  ['hermes','renewals','cases','carrier','intake','finance','nextcloud']);
assert.equal(catalog.find(s => s.id === 'renewals').mode, 'via Hermes');
assert.equal(catalog.find(s => s.id === 'cases').healthUrl, 'http://hub:8787/api/hermes/sync-health');

const split = serviceCatalog({
  HERMES_API_URL:'http://hub:8787',
  HERMES_RENEWALS_URL:'http://renewals:8804/',
  HERMES_CASES_URL:'http://cases:8802/',
});
assert.equal(split.find(s => s.id === 'renewals').healthUrl, 'http://renewals:8804/health');
assert.equal(split.find(s => s.id === 'cases').mode, 'service');

const safe = publicService(split[0], { status:'online', detail:'Responding' });
assert.equal(safe.healthUrl, undefined, 'internal service URL leaked to browser');
assert.equal(safe.auth, undefined, 'credential mode leaked to browser');

console.log('service catalog tests passed');
