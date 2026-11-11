const assert = require('node:assert/strict');
const test = require('node:test');
const { SharePointSiteDiscovery } = require('../src/sharePointSiteDiscovery');

const MOCK_CONFIG = {
  tenantId: 'tenant-123',
  clientId: 'client-456',
  clientSecret: 'secret-789'
};

function createMockFetch(responseMap) {
  return async (url, options) => {
    const key = url.split('?')[0]; // Remove query params for matching
    const response = responseMap[key];
    if (!response) {
      return {
        ok: false,
        status: 404,
        text: async () => 'Not Found'
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => response
    };
  };
}

test('SharePointSiteDiscovery', async (t) => {
  await t.test('discoverSites returns normalized site list', async () => {
    const mockResponses = {
      'https://graph.microsoft.com/v1.0/sites': {
        value: [
          { id: 'site-1', displayName: 'AI4 Management', webUrl: 'https://tenant.sharepoint.com/sites/ai4mgmt' },
          { id: 'site-2', displayName: 'General', webUrl: 'https://tenant.sharepoint.com/sites/general' },
          { id: 'site-3', displayName: 'CN_AI依頼台帳', webUrl: 'https://tenant.sharepoint.com/sites/cn-ai' }
        ]
      },
      'https://login.microsoftonline.com/tenant-123/oauth2/v2.0/token': {
        access_token: 'token-abc',
        expires_in: 3600
      }
    };

    const discovery = new SharePointSiteDiscovery({
      ...MOCK_CONFIG,
      fetchImpl: createMockFetch(mockResponses)
    });

    const sites = await discovery.discoverSites();
    assert.equal(sites.length, 3);
    assert.equal(sites[0].displayName, 'AI4 Management');
    assert.equal(sites[0].normalizedName, 'ai4 management');
    assert.equal(sites[2].normalizedName, 'cn_ai依頼台帳');
  });

  await t.test('discoverListsBySite returns lists for specific site', async () => {
    const mockResponses = {
      'https://graph.microsoft.com/v1.0/sites/site-1/lists': {
        value: [
          { id: 'list-1', displayName: '支払管理' },
          { id: 'list-2', displayName: '請求管理' },
          { id: 'list-3', displayName: '案件管理' }
        ]
      },
      'https://login.microsoftonline.com/tenant-123/oauth2/v2.0/token': {
        access_token: 'token-abc',
        expires_in: 3600
      }
    };

    const discovery = new SharePointSiteDiscovery({
      ...MOCK_CONFIG,
      fetchImpl: createMockFetch(mockResponses)
    });

    const lists = await discovery.discoverListsBySite('site-1');
    assert.equal(lists.length, 3);
    assert.equal(lists[0].displayName, '支払管理');
    assert.equal(lists[0].normalizedName, '支払管理');
    assert.equal(lists[0].siteId, 'site-1');
  });

  await t.test('findAI4Resources discovers and categorizes AI4 lists', async () => {
    const mockResponses = {
      'https://graph.microsoft.com/v1.0/sites': {
        value: [
          { id: 'site-ai4', displayName: 'AI4 Management', webUrl: 'https://tenant.sharepoint.com/sites/ai4' },
          { id: 'site-other', displayName: 'Other Site', webUrl: 'https://tenant.sharepoint.com/sites/other' }
        ]
      },
      'https://graph.microsoft.com/v1.0/sites/site-ai4/lists': {
        value: [
          { id: 'list-payment', displayName: '支払管理' },
          { id: 'list-invoice', displayName: '請求管理' },
          { id: 'list-project', displayName: '案件管理' },
          { id: 'list-employee', displayName: '社員管理' }
        ]
      },
      'https://login.microsoftonline.com/tenant-123/oauth2/v2.0/token': {
        access_token: 'token-abc',
        expires_in: 3600
      }
    };

    const discovery = new SharePointSiteDiscovery({
      ...MOCK_CONFIG,
      fetchImpl: createMockFetch(mockResponses)
    });

    const results = await discovery.findAI4Resources();
    assert.equal(results.sites.length, 2);
    assert.equal(results.payments.length, 1);
    assert.equal(results.invoices.length, 1);
    assert.equal(results.projects.length, 1);
    assert.equal(results.employees.length, 1);
    assert.equal(results.payments[0].displayName, '支払管理');
    assert.equal(results.invoices[0].displayName, '請求管理');
  });

  await t.test('findAI4Resources falls back to all sites if no AI4-specific site found', async () => {
    const mockResponses = {
      'https://graph.microsoft.com/v1.0/sites': {
        value: [
          { id: 'site-1', displayName: 'General', webUrl: 'https://tenant.sharepoint.com/sites/general' },
          { id: 'site-2', displayName: 'HR Systems', webUrl: 'https://tenant.sharepoint.com/sites/hr' }
        ]
      },
      'https://graph.microsoft.com/v1.0/sites/site-1/lists': {
        value: [
          { id: 'list-payment', displayName: 'Payment Tracking' }
        ]
      },
      'https://graph.microsoft.com/v1.0/sites/site-2/lists': {
        value: [
          { id: 'list-inv', displayName: 'Invoice Management' }
        ]
      },
      'https://login.microsoftonline.com/tenant-123/oauth2/v2.0/token': {
        access_token: 'token-abc',
        expires_in: 3600
      }
    };

    const discovery = new SharePointSiteDiscovery({
      ...MOCK_CONFIG,
      fetchImpl: createMockFetch(mockResponses)
    });

    const results = await discovery.findAI4Resources();
    assert.equal(results.sites.length, 2);
    assert.equal(results.payments.length, 1);
    assert.equal(results.invoices.length, 1);
  });

  await t.test('getRecommendedLists returns best-match selections', async () => {
    const discoveryResults = {
      payments: [
        { id: 'p1', displayName: '支払管理', siteId: 'site-1' },
        { id: 'p2', displayName: 'Payments Backup', siteId: 'site-2' }
      ],
      invoices: [
        { id: 'inv1', displayName: '請求管理', siteId: 'site-1' }
      ],
      projects: [
        { id: 'proj1', displayName: '案件管理', siteId: 'site-1' },
        { id: 'proj2', displayName: '工事管理', siteId: 'site-2' }
      ],
      employees: []
    };

    const discovery = new SharePointSiteDiscovery(MOCK_CONFIG);
    const recommendations = discovery.getRecommendedLists(discoveryResults);

    assert.equal(recommendations.found.paymentLists, 2);
    assert.equal(recommendations.found.invoiceLists, 1);
    assert.equal(recommendations.found.projectLists, 2);
    assert.equal(recommendations.found.employeeLists, 0);
    assert.equal(recommendations.recommendations.payment.displayName, '支払管理');
    assert.equal(recommendations.recommendations.invoice.displayName, '請求管理');
    assert.equal(recommendations.recommendations.employees, null);
  });

  await t.test('_assertConfig throws on missing configuration', async () => {
    const discovery = new SharePointSiteDiscovery({
      tenantId: 'tenant-123'
      // clientId and clientSecret missing
    });

    assert.throws(() => discovery._assertConfig(), /SHAREPOINT_CLIENT_ID/);
  });

  await t.test('findAI4Resources handles API errors gracefully', async () => {
    const mockResponses = {
      'https://graph.microsoft.com/v1.0/sites': {
        value: [
          { id: 'site-1', displayName: 'AI4 Management', webUrl: 'https://tenant.sharepoint.com/sites/ai4' }
        ]
      },
      'https://graph.microsoft.com/v1.0/sites/site-1/lists': null, // This will trigger 404
      'https://login.microsoftonline.com/tenant-123/oauth2/v2.0/token': {
        access_token: 'token-abc',
        expires_in: 3600
      }
    };

    const discovery = new SharePointSiteDiscovery({
      ...MOCK_CONFIG,
      fetchImpl: createMockFetch(mockResponses)
    });

    const results = await discovery.findAI4Resources();
    assert.equal(results.sites.length, 1);
    // Error is caught and logged, discovery continues
  });

  await t.test('tokenization caches token within TTL', async () => {
    let tokenCallCount = 0;
    const mockResponses = {
      'https://graph.microsoft.com/v1.0/sites': {
        value: [{ id: 'site-1', displayName: 'AI4 Management', webUrl: 'https://...' }]
      },
      'https://login.microsoftonline.com/tenant-123/oauth2/v2.0/token': {
        access_token: 'token-abc',
        expires_in: 3600
      }
    };

    const mockFetch = async (url, options) => {
      if (url.includes('oauth2')) tokenCallCount++;
      return createMockFetch(mockResponses)(url, options);
    };

    const discovery = new SharePointSiteDiscovery({
      ...MOCK_CONFIG,
      fetchImpl: mockFetch
    });

    // Call discoverSites twice, should reuse token from cache
    await discovery.discoverSites();
    await discovery.discoverSites();

    assert.equal(tokenCallCount, 1, 'Token should be cached and reused');
  });

  await t.test('categorization matches Japanese and English variants', async () => {
    const discovery = new SharePointSiteDiscovery(MOCK_CONFIG);
    const results = { payments: [], invoices: [], projects: [], employees: [] };

    const lists = [
      { id: 'l1', displayName: '支払管理', normalizedName: '支払管理' },
      { id: 'l2', displayName: 'Payment Tracking', normalizedName: 'payment tracking' },
      { id: 'l3', displayName: '振込', normalizedName: '振込' },
      { id: 'l4', displayName: '請求管理', normalizedName: '請求管理' },
      { id: 'l5', displayName: 'Invoice List', normalizedName: 'invoice list' },
      { id: 'l6', displayName: '案件', normalizedName: '案件' },
      { id: 'l7', displayName: 'Project Tracking', normalizedName: 'project tracking' },
      { id: 'l8', displayName: '工事', normalizedName: '工事' },
      { id: 'l9', displayName: '社員管理', normalizedName: '社員管理' },
      { id: 'l10', displayName: 'Staff Directory', normalizedName: 'staff directory' }
    ];

    discovery._categorizeAndAddLists(lists, results);

    assert.equal(results.payments.length, 3, '3 payment lists expected');
    assert.equal(results.invoices.length, 2, '2 invoice lists expected');
    assert.equal(results.projects.length, 3, '3 project lists expected');
    assert.equal(results.employees.length, 2, '2 employee lists expected');
  });
});
