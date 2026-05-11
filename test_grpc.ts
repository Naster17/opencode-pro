
import { streamChat } from './plugins/opencode-windsurf-auth/src/plugin/grpc-client.js';
import { WindsurfErrorCode } from './plugins/opencode-windsurf-auth/src/plugin/auth.js';

const credentials = {
  csrfToken: '6688e103-928a-4114-a111-e630812a93c3',
  apiKey: 'sk-ws-01-JEgd3Y7iIfEqwteb2F_HaS8i0kjImq2E1qQhkqFTrCIWjreFSaNeApJq6m0GnpcZ4piJotz5gpKv8VANwf_eoj7rcb8A8A',
  port: 46507,
  version: '0.2.0'
};

const options = {
  model: 'claude-3.5-sonnet',
  messages: [
    { role: 'user', content: 'hello' }
  ],
  onChunk: (text) => process.stdout.write(text),
};

console.log("Starting gRPC test with v2.2.17 protocol mimicry...");

streamChat(credentials, options)
  .then(fullText => {
    console.log("\n\nTest successful! Full response length:", fullText.length);
    process.exit(0);
  })
  .catch(err => {
    console.error("\n\nTest failed!");
    console.error("Error Message:", err.message);
    if (err.cause) console.error("Cause:", err.cause);
    process.exit(1);
  });
