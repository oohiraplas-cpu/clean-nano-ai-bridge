'use strict';
// Read-only, uncached Dataverse canvas metadata observer. Never treats lastpublishtime alone as version proof.
async function readCanvasPublicationMetadata({ store, expectedAppId, expectedEnvironmentId } = {}) {
  const deny = reason => Object.freeze({ verified: false, reason });
  if (!store || typeof store.dataverseRequest !== 'function' || !expectedAppId || !expectedEnvironmentId ||
      store.appId !== expectedAppId || store.environmentId !== expectedEnvironmentId) return deny('reader_not_configured');
  let record;
  try {
    record = await store.dataverseRequest('canvasapps(' + encodeURIComponent(expectedAppId) + ')?$select=canvasappid,appversion,lastpublishtime,lastmodifiedtime');
  } catch { return deny('metadata_unavailable'); }
  if (!record || String(record.canvasappid || '').toLowerCase() !== expectedAppId.toLowerCase() ||
      !record.appversion || !record.lastpublishtime) return deny('metadata_incomplete');
  return Object.freeze({
    verified: false,
    appId: expectedAppId, environmentId: expectedEnvironmentId,
    currentVersion: record.appversion, lastPublishTime: record.lastpublishtime,
    reason: 'published_version_not_independently_identified'
  });
}
module.exports = { readCanvasPublicationMetadata };
