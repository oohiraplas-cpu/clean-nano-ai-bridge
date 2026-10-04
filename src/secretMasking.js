/**
 * 診断ログや応答に混入しうる秘密値（トークン、APIキー、接続文字列など）をマスクする。
 * 完全な検出は保証しない。既知の形式と、設定済みの秘密値そのもの（extraSecrets）を対象にする。
 */
const MASK = '***MASKED***';

const SENSITIVE_CONNECTION_KEY = /\b(password|pwd|accountkey|sharedaccess\w*|server|data source|endpoint|defaultendpointsprotocol|user id|uid|hostname)\s*=/i;
const CONNECTION_STRING_RUN = /\b(?:[A-Za-z][A-Za-z ]{1,30}=[^;\r\n]*;){2,}(?:[A-Za-z][A-Za-z ]{1,30}=[^;\r\n]*;?)?/g;

const RULES = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, MASK],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${MASK}`],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, MASK],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, MASK],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, MASK],
  [/\b(authorization|x-api-key|api-key|x-functions-key|ocp-apim-subscription-key|set-cookie|cookie)\s*[:=]\s*[^\r\n]+/gi, `$1: ${MASK}`],
  [/([?&](?:sig|signature|access_token|client_secret|api_key|apikey|x-api-key|token|code)=)[^&\s"']+/gi, `$1${MASK}`],
  [/("(?:password|secret|client_secret|clientSecret|token|access_token|refresh_token|api_key|apiKey|authorization|connectionString|connection_string|sasToken)"\s*:\s*)"[^"]*"/gi, `$1"${MASK}"`],
  [/\b(AccountKey|SharedAccessKey|SharedAccessSignature|Password|Pwd|ClientSecret|ApiKey)\s*=\s*[^;\s"']+/gi, `$1=${MASK}`],
  [/\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|API_KEY|APIKEY|CONNECTION_STRING|PRIVATE_KEY)[A-Z0-9_]*)\s*[=:]\s*\S+/g, `$1=${MASK}`]
];

function maskSecrets(text, extraSecrets = []) {
  if (typeof text !== 'string' || !text) return text;
  let result = text;
  for (const secret of extraSecrets) {
    if (typeof secret === 'string' && secret.length >= 6) result = result.split(secret).join(MASK);
  }
  // 個別の形式（トークン等）を先にマスクし、その後で接続文字列を「key=value;」の連なりごと隠す。
  for (const [pattern, replacement] of RULES) result = result.replace(pattern, replacement);
  result = result.replace(CONNECTION_STRING_RUN, (match) => (SENSITIVE_CONNECTION_KEY.test(match) ? MASK : match));
  return result;
}

const SECRET_KEY_NAME = /(secret|password|token|api[-_]?key|authorization|connection[-_]?string|credential|sas)/i;

function maskDeep(value, extraSecrets = []) {
  if (typeof value === 'string') return maskSecrets(value, extraSecrets);
  if (Array.isArray(value)) return value.map((item) => maskDeep(item, extraSecrets));
  if (value && typeof value === 'object') {
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = typeof item === 'string' && SECRET_KEY_NAME.test(key) ? MASK : maskDeep(item, extraSecrets);
    }
    return result;
  }
  return value;
}

// 変更内容（Power Appsソース）に、明らかな秘密値が混入していないかの厳しめ判定。
// 誤検出を避けるため、トークン/JWT/秘密鍵/接続文字列の強いパターンだけを対象にする。
function containsLikelySecret(text) {
  if (typeof text !== 'string' || !text) return false;
  return /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)
    || /\bgithub_pat_[A-Za-z0-9_]{20,}/.test(text)
    || /\bgh[pousr]_[A-Za-z0-9]{20,}/.test(text)
    || /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/.test(text)
    || /\b(AccountKey|SharedAccessKey|Password|Pwd)\s*=\s*[^;\s"']{6,}/i.test(text);
}

module.exports = { MASK, maskSecrets, maskDeep, containsLikelySecret };
