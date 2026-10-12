'use strict';
// Policy-only observer: trusted readers must attest to a specific Live version.
// No Power Apps API writes, inferred publish status, or caller-supplied approval flags.
async function verifyLiveCanvasVersion({ readLiveVersion, appId, environmentId, expectedVersion } = {}) {
  const blocked = reason => Object.freeze({ verified:false, reason });
  if (typeof readLiveVersion !== 'function' || !appId || !environmentId || !expectedVersion) return blocked('live_reader_not_configured');
  let evidence;
  try { evidence = await readLiveVersion({ appId, environmentId }); }
  catch { return blocked('live_version_read_failed'); }
  if (!evidence || evidence.source !== 'powerapps_live_version' || evidence.appId !== appId ||
      evidence.environmentId !== environmentId || evidence.liveVersion !== expectedVersion ||
      evidence.verified !== true) return blocked('live_version_unverified');
  return Object.freeze({ verified:true, liveVersion:expectedVersion });
}
module.exports = { verifyLiveCanvasVersion };
