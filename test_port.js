
import * as http2 from 'http2';

const csrfToken = '6688e103-928a-4114-a111-e630812a93c3';
const ports = [38781, 46507];

async function testPort(port) {
  console.log(`Testing port ${port}...`);
  return new Promise((resolve) => {
    const client = http2.connect(`http://localhost:${port}`);
    client.on('error', (err) => {
      console.log(`Port ${port} failed: ${err.message}`);
      resolve(false);
    });

    const req = client.request({
      ':method': 'POST',
      ':path': '/exa.language_server_pb.LanguageServerService/GetModelStatuses',
      'content-type': 'application/grpc',
      'x-codeium-csrf-token': csrfToken,
    });

    // Empty body (approximate, since we don't need real metadata for a quick check)
    const body = Buffer.alloc(5);
    body[0] = 0;
    body.writeUInt32BE(0, 1);
    
    req.on('response', (headers) => {
      console.log(`Port ${port} response:`, headers[':status']);
      resolve(true);
    });

    req.on('error', (err) => {
      console.log(`Port ${port} request error: ${err.message}`);
      resolve(false);
    });

    req.end(body);
    
    setTimeout(() => {
      client.close();
      resolve(false);
    }, 2000);
  });
}

async function main() {
  for (const port of ports) {
    await testPort(port);
  }
}

main();
