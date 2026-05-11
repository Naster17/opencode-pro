
import * as http2 from 'http2';

const csrfToken = '6688e103-928a-4114-a111-e630812a93c3';
const apiKey = 'sk-ws-01-JEgd3Y7iIfEqwteb2F_HaS8i0kjImq2E1qQhkqFTrCIWjreFSaNeApJq6m0GnpcZ4piJotz5gpKv8VANwf_eoj7rcb8A8A';
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
      ':path': '/exa.language_server_pb.LanguageServerService/RawGetChatMessage',
      'content-type': 'application/grpc',
      'x-codeium-csrf-token': csrfToken,
      'authorization': `Bearer ${apiKey}`,
    });

    // Minimal request body (Metadata + 1 message + model 109)
    // Metadata: [Tag 3][Length][API Key]
    // ChatMessages: [Tag 2][Length]
    // Model: [Tag 4][109]
    
    // For simplicity, just send an empty-ish request to see if it even reaches the logic
    const body = Buffer.alloc(10);
    body[0] = 0;
    body.writeUInt32BE(5, 1); // payload len 5
    
    req.on('response', (headers) => {
      console.log(`Port ${port} response:`, headers[':status']);
      if (headers['grpc-status']) console.log(`Port ${port} grpc-status:`, headers['grpc-status']);
      if (headers['grpc-message']) console.log(`Port ${port} grpc-message:`, headers['grpc-message']);
      resolve(true);
    });

    req.on('error', (err) => {
      console.log(`Port ${port} request error: ${err.message}`);
      resolve(false);
    });
    
    req.on('trailers', (trailers) => {
      console.log(`Port ${port} trailers:`, trailers);
      resolve(true);
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
