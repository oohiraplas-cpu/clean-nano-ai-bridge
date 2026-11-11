/**
 * Bridge共通のエラー生成ヘルパー。
 * server.jsのMCPエラー規約（tools/callはHTTP 200 + isError:true、legacy形式はerror.statusをHTTPステータスに使用）に合わせ、
 * 必ずstatusを持つErrorを作る。payloadはstructuredContent / legacy応答へ追加で返す機械可読フィールド。
 */
function bridgeError(message, status = 400, payload) {
  const error = new Error(message);
  error.status = status;
  if (payload !== undefined) error.payload = payload;
  return error;
}

/**
 * 未構成の外部APIをダミー成功にしないためのエラー。
 * status / reason / missingConfiguration を必ず返す（HTTP 503、tools/callではisError:true）。
 */
function notConfiguredError(reason, missingConfiguration) {
  return bridgeError(`未構成のため実行できません: ${reason}`, 503, {
    status: 'not_configured',
    reason,
    missingConfiguration: [...missingConfiguration]
  });
}

/**
 * 上流APIの非2xx応答を、秘密値を含めずHTTP status付きのErrorにする（error.upstreamは既存規約）。
 * Bridgeとしては502（上流異常）で返し、上流のHTTP statusはdetailsに保持する。
 */
async function upstreamResponseError(step, response, mask = (value) => value) {
  let errorMessage = null;
  try {
    const text = await response.text();
    try {
      const body = text ? JSON.parse(text) : {};
      errorMessage = body.message || (body.error && body.error.message) || (typeof body.error === 'string' ? body.error : null);
    } catch {
      errorMessage = text;
    }
  } catch {
    // 本文が読めない場合はstatusのみ返す
  }
  if (typeof errorMessage === 'string') errorMessage = mask(errorMessage.split(/\r?\n/)[0]).slice(0, 300);
  else errorMessage = null;
  const error = bridgeError(
    `${step}に失敗しました (HTTP ${response.status})${errorMessage ? `: ${errorMessage}` : ''}`,
    502
  );
  error.upstream = { step, httpStatus: response.status, errorCode: null, errorMessage };
  error.retryable = response.status === 429 || response.status >= 500;
  return error;
}

module.exports = { bridgeError, notConfiguredError, upstreamResponseError };
