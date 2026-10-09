/**
 * SharePoint サイト自動探索
 * Microsoft Graph 経由でテナント内のサイト・リストを検索し、
 * AI4関連リストを特定する。
 */

class SharePointSiteDiscovery {
  constructor(config = {}) {
    this.tenantId = config.tenantId || '';
    this.clientId = config.clientId || '';
    this.clientSecret = config.clientSecret || '';
    this.graphBaseUrl = config.graphBaseUrl || 'https://graph.microsoft.com/v1.0';
    this.tokenUrl = config.tokenUrl || `https://login.microsoftonline.com/${this.tenantId}/oauth2/v2.0/token`;
    this._fetch = config.fetchImpl || fetch;
    this._token = null;
    this._tokenExpiresAt = 0;
  }

  _assertConfig() {
    const missing = [];
    if (!this.tenantId) missing.push('SHAREPOINT_TENANT_ID');
    if (!this.clientId) missing.push('SHAREPOINT_CLIENT_ID');
    if (!this.clientSecret) missing.push('SHAREPOINT_CLIENT_SECRET');
    if (missing.length) throw new Error(`SharePoint設定が不足しています: ${missing.join(', ')}`);
  }

  async _getAccessToken() {
    const now = Date.now();
    if (this._token && now < this._tokenExpiresAt - 30000) return this._token;
    const body = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials'
    });
    const response = await this._fetch(this.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    });
    if (!response.ok) throw new Error(`認証失敗 (${response.status})`);
    const data = await response.json();
    this._token = data.access_token;
    this._tokenExpiresAt = now + data.expires_in * 1000;
    return this._token;
  }

  async _graphFetch(path) {
    const token = await this._getAccessToken();
    const response = await this._fetch(`${this.graphBaseUrl}${path}`, {
      headers: { authorization: `Bearer ${token}` }
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Graph API エラー (${response.status}): ${detail.slice(0, 200)}`);
    }
    return response.json();
  }

  /**
   * テナント内のサイト一覧を取得
   * @returns {Array} sites
   */
  async discoverSites() {
    this._assertConfig();
    const data = await this._graphFetch('/sites?$select=id,displayName,webUrl&$top=100');
    const sites = (data.value || []).map(site => ({
      id: site.id,
      displayName: site.displayName,
      webUrl: site.webUrl,
      normalizedName: (site.displayName || '').toLowerCase()
    }));
    return sites;
  }

  /**
   * 特定サイトのリスト一覧を取得
   * @param {string} siteId SharePoint サイト ID
   * @returns {Array} lists
   */
  async discoverListsBySite(siteId) {
    this._assertConfig();
    if (!siteId) throw new Error('siteId is required');
    const data = await this._graphFetch(`/sites/${siteId}/lists?$select=id,displayName&$top=100`);
    const lists = (data.value || []).map(list => ({
      id: list.id,
      displayName: list.displayName,
      normalizedName: (list.displayName || '').toLowerCase(),
      siteId
    }));
    return lists;
  }

  /**
   * AI4関連サイト・リストを検索
   * @returns {object} { sites, payments, invoices, projects }
   */
  async findAI4Resources() {
    this._assertConfig();
    const results = {
      sites: [],
      payments: [],
      invoices: [],
      projects: [],
      employees: []
    };

    try {
      const sites = await this.discoverSites();
      results.sites = sites;

      // AI4 関連サイトを検索（名称に AI4 を含む）
      const ai4Sites = sites.filter(s =>
        s.normalizedName.includes('ai4') ||
        s.normalizedName.includes('ai依頼') ||
        s.normalizedName.includes('cleannano')
      );

      if (ai4Sites.length === 0) {
        // AI4 サイトが見つからない場合、全サイトを対象にリスト検索
        for (const site of sites) {
          try {
            const lists = await this.discoverListsBySite(site.id);
            this._categorizeAndAddLists(lists, results);
          } catch (error) {
            // サイトアクセス不可の場合はスキップ
          }
        }
      } else {
        // AI4 サイト内のリストを検索
        for (const site of ai4Sites) {
          try {
            const lists = await this.discoverListsBySite(site.id);
            this._categorizeAndAddLists(lists, results);
          } catch (error) {
            console.warn(`AI4 サイト ${site.displayName} のリスト取得エラー: ${error.message}`);
          }
        }
      }
    } catch (error) {
      results.error = error.message;
    }

    return results;
  }

  /**
   * リストを支払・請求・案件に分類
   */
  _categorizeAndAddLists(lists, results) {
    lists.forEach(list => {
      const normalized = list.normalizedName;
      if (normalized.includes('支払') || normalized.includes('payment') || normalized.includes('振込')) {
        results.payments.push(list);
      } else if (normalized.includes('請求') || normalized.includes('invoice') || normalized.includes('billing')) {
        results.invoices.push(list);
      } else if (normalized.includes('案件') || normalized.includes('project') || normalized.includes('工事')) {
        results.projects.push(list);
      } else if (normalized.includes('社員') || normalized.includes('employee') || normalized.includes('スタッフ') || normalized.includes('staff')) {
        results.employees.push(list);
      }
    });
  }

  /**
   * 複合結果からベストマッチを推定
   */
  getRecommendedLists(discoveryResults) {
    const recommendations = {
      payment: discoveryResults.payments[0] || null,
      invoice: discoveryResults.invoices[0] || null,
      project: discoveryResults.projects[0] || null,
      employees: discoveryResults.employees[0] || null
    };

    return {
      found: {
        paymentLists: discoveryResults.payments.length,
        invoiceLists: discoveryResults.invoices.length,
        projectLists: discoveryResults.projects.length,
        employeeLists: discoveryResults.employees.length
      },
      recommendations,
      discoveryResults
    };
  }
}

module.exports = { SharePointSiteDiscovery };
