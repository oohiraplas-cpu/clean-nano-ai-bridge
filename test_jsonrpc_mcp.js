const { createApp } = require('./src/server');
const { getConfig } = require('./src/config');

async function test() {
  const config = getConfig();
  const app = createApp(config);
  
  const server = app.listen(0, 'localhost', async () => {
    const addr = server.address();
    const port = addr.port;
    const baseUrl = `http://localhost:${port}`;
    
    try {
      // Test JSON-RPC 2.0 tools/list
      const res = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ 
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
          params: {}
        })
      });
      
      console.log(`JSON-RPC 2.0 tools/list: ${res.status}`);
      const data = await res.json();
      console.log(JSON.stringify(data, null, 2).slice(0, 500));
      console.log('...(truncated)');
    } catch (error) {
      console.error('Error:', error.message);
    } finally {
      server.close();
    }
  });
}

test();
