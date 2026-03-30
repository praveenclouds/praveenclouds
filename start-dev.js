/**
 * start-dev.js — Starts an in-memory MongoDB, seeds it, then launches the server.
 * Usage: node start-dev.js
 */
const { MongoMemoryServer } = require('mongodb-memory-server');

(async () => {
  console.log('🔧  Starting in-memory MongoDB…');
  const mongod = await MongoMemoryServer.create({
    instance: { port: 27017, dbName: 'terzo_assets' },
  });
  const uri = mongod.getUri();
  console.log(`✅  In-memory MongoDB ready → ${uri}`);

  process.env.MONGO_URI = uri;

  // Now load and run the actual server
  require('./server.js');
})().catch(err => {
  console.error('❌  Failed to start dev server:', err.message);
  process.exit(1);
});
