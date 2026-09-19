// Power Automateの「HTTP要求受信時」トリガーを持つフローを、キー名経由で実行するクラス。
// トリガーURL自体はSAS署名を含む機密情報のため、コードにもチャットにも一切含めず、
// デプロイ環境変数 POWER_AUTOMATE_FLOWS（JSON文字列: {"flowKey": "https://...トリガーURL"}）
// としてのみ保持する（src/config.jsでパースしてconfig.powerAutomate.flowsに渡す）。
// 呼び出し側（server.js）は、approvedByHuman:trueが明示されたリクエストのみをここへ渡す
// 前提で設計している（実行系は人間承認必須、というBridge全体の方針に合わせる）。
class PowerAutomateRunner {
  constructor(config = {}) {
    this.flows = config.flows || {};
    this._fetch = config.fetchImpl || fetch;
  }

  async runFlow(flowKey, payload) {
    const url = this.flows[flowKey];
    if (!url) {
      const known = Object.keys(this.flows);
      const knownNote = known.length ? `（設定済みflowKey: ${known.join(', ')}）` : '（現在フローは1件も設定されていません）';
      throw new Error(`指定されたflowKeyのPower Automateフローが設定されていません: ${flowKey}${knownNote}`);
    }
    const response = await this._fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload || {})
    });
    const text = await response.text().catch(() => '');
    let body = text;
    try { body = text ? JSON.parse(text) : null; } catch { /* JSON以外の応答はそのままテキストで扱う */ }
    if (!response.ok) {
      const error = new Error(`Power Automateフロー実行に失敗しました (${response.status}): ${(typeof body === 'string' ? body : JSON.stringify(body)).slice(0, 200)}`);
      error.status = 502;
      throw error;
    }
    return { status: 'ok', flowKey, httpStatus: response.status, result: body };
  }
}

module.exports = { PowerAutomateRunner };
