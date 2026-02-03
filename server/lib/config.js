/**
 * Configuration Management
 * Handles command-line arguments and environment variables
 */

function getArg(name) {
    const withEquals = process.argv.find(arg => arg.startsWith(`--${name}=`));
    if (withEquals) return withEquals.split('=')[1];
    
    const index = process.argv.indexOf(`--${name}`);
    if (index !== -1 && index + 1 < process.argv.length) {
        return process.argv[index + 1];
    }
    return null;
}

function parsePoolUrl(url) {
    const match = url.match(/stratum\+tcp:\/\/([^:]+):(\d+)/);
    if (!match) {
        throw new Error(`Invalid pool URL: ${url}`);
    }
    return { host: match[1], port: parseInt(match[2]) };
}

const config = {
    poolUrl: process.env.POOL_URL || getArg('pool') || 'stratum+tcp://pool.verus.io:9998',
    poolUser: process.env.POOL_USER || getArg('user') || '',
    poolPass: process.env.POOL_PASS || getArg('pass') || 'x',
    wsPort: parseInt(process.env.WS_PORT || getArg('port') || '8080'),
    debug: process.argv.includes('--debug') || process.env.DEBUG === '1',
    testMode: process.argv.includes('--test-mode') || process.env.TEST_MODE === '1'
};

// Pre-parse pool info
config.poolInfo = parsePoolUrl(config.poolUrl);

module.exports = {
    config,
    parsePoolUrl
};
