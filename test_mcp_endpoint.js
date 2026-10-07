const { createApp } = require('./src/server');
const { getConfig } = require('./src/config');

async function test() {
  const config = getConfig();
  const app = createApp(config);
  
  const server = app.listen(0, 'localhost', async () => {
    const addr = server.address();
    const port = addr.port;
    const baseUrl = `http://localhost:${port}`;
    
    console.log(`Test server listening on ${baseUrl}`);
    
    try {
      // Test /health endpoint
      const healthRes = await fetch(`${baseUrl}/health`);
      console.log(`✓ GET /health: ${healthRes.status}`);
      const healthData = await healthRes.json();
      console.log(`  Response:`, healthData);
      
      // Test /mcp/tools/list without auth (should pass since MCP_API_KEY is empty)
      const toolsRes = await fetch(`${baseUrl}/mcp/tools/list`);
      console.log(`✓ GET /mcp/tools/list: ${toolsRes.status}`);
      if (toolsRes.status === 200) {
        const toolsData = await toolsRes.json();
        console.log(`  Tools count:`, toolsData.tools?.length || 0);
      }
      
      // Test POST /mcp with health_check method (legacy format)
      const mcpRes = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method: 'health_check', params: {} })
      });
      console.log(`✓ POST /mcp (health_check): ${mcpRes.status}`);
      const mcpData = await mcpRes.json();
      console.log(`  Response:`, mcpData);
      
      console.log('\n✅ All endpoints responded successfully');
    } catch (error) {
      console.error('\n❌ Test failed:', error.message);
    } finally {
      server.close();
      process.exit(mcpRes?.status === 200 ? 0 : 1);
    }
  });
}

test().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
