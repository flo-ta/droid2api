import app from './app.js';
import { loadConfig, isDevMode, getPort } from './config.js';
import { logInfo, logError } from './logger.js';
import { initializeAuth } from './auth.js';
import { initializeUserAgentUpdater } from './user-agent-updater.js';

(async () => {
  try {
    loadConfig();
    logInfo('Configuration loaded successfully');
    logInfo(`Dev mode: ${isDevMode()}`);

    // Load .env and validate both keys before starting background work or listening.
    initializeAuth();
    initializeUserAgentUpdater();

    const PORT = getPort();
  logInfo(`Starting server on port ${PORT}...`);

  const server = app.listen(PORT)
    .on('listening', () => {
      logInfo(`Server running on http://localhost:${PORT}`);
      logInfo('Available endpoints:');
      logInfo('  GET  /v1/models');
      logInfo('  POST /v1/chat/completions');
      logInfo('  POST /v1/responses');
      logInfo('  POST /v1/messages');
      logInfo('  POST /v1/messages/count_tokens');
      logInfo('  POST /v1/generate');
    })
    .on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`\n${'='.repeat(80)}`);
        console.error(`ERROR: Port ${PORT} is already in use!`);
        console.error('');
        console.error('Please choose one of the following options:');
        console.error(`  1. Stop the process using port ${PORT}:`);
        console.error(`     lsof -ti:${PORT} | xargs kill`);
        console.error('');
        console.error('  2. Change the port in config.json:');
        console.error('     Edit config.json and modify the "port" field');
        console.error(`${'='.repeat(80)}\n`);
        process.exit(1);
      } else {
        logError('Failed to start server', err);
        process.exit(1);
      }
    });
  } catch (error) {
    logError('Failed to start server', error);
    process.exit(1);
  }
})();
