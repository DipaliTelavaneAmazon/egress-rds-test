const express = require('express');
const mysql = require('mysql2');
const dns = require('dns').promises;

const app = express();

// Configuration
const dbConfig = {
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD,
    database: 'V2NCanaryDB',
    port: 3306,
    connectionLimit: 10
};

const rdsEndpoint = process.env.RDS_ENDPOINT;

// Create separate pools for IPv4 and IPv6
let ipv4Pool = null;
let ipv6Pool = null;

function createPool(host, version) {
    const config = {
        ...dbConfig,
        host: host
    };

    if (version === 'IPv6') {
        host = host.replace(/[\[\]]/g, '');
        config.host = host;
        config.family = 6;
    }

    return mysql.createPool(config);
}

async function testConnection(pool, version) {
    return new Promise((resolve, reject) => {
        pool.getConnection((err, connection) => {
            if (err) {
                console.error(`${version} connection error:`, err);
                return resolve({
                    success: false,
                    error: err.message,
                    details: {
                        code: err.code,
                        errno: err.errno
                    }
                });
            }

            connection.query('SELECT 1 as test', (error, results) => {
                if (error) {
                    connection.release();
                    return resolve({
                        success: false,
                        error: error.message
                    });
                }

                connection.query('SELECT @@hostname, @@port, DATABASE()', (error, connectionInfo) => {
                    connection.release();
                    if (error) {
                        return resolve({
                            success: false,
                            error: error.message
                        });
                    }

                    resolve({
                        success: true,
                        data: {
                            test: results,
                            connectionInfo
                        }
                    });
                });
            });
        });
    });
}

// Initialize pools
async function initializePools() {
    try {
        const addresses = await resolveHostname(rdsEndpoint);
        
        // Initialize IPv4 pool
        ipv4Pool = createPool(addresses.ipv4, 'IPv4');
        ipv4Pool.on('error', err => {
            console.error('Unexpected error on IPv4 pool', err);
        });

        // Initialize IPv6 pool
        ipv6Pool = createPool(addresses.ipv6, 'IPv6');
        ipv6Pool.on('error', err => {
            console.error('Unexpected error on IPv6 pool', err);
        });

        console.log('Connection pools initialized successfully');
    } catch (error) {
        console.error('Failed to initialize pools:', error);
        throw error;
    }
}

async function resolveHostname(hostname) {
    try {
        console.log('Resolving hostname:', hostname);
        
        const ipv4Addresses = await dns.resolve4(hostname);
        console.log('IPv4 addresses:', ipv4Addresses);

        const ipv6Addresses = await dns.resolve6(hostname);
        console.log('IPv6 addresses:', ipv6Addresses);

        return {
            ipv4: ipv4Addresses[0],
            ipv6: ipv6Addresses[0]
        };
    } catch (error) {
        console.error('DNS resolution error:', error);
        throw error;
    }
}

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ 
        status: 'healthy',
        timestamp: new Date().toISOString()
    });
});

// IPv4 test endpoint
app.get('/test-connections/ipv4', async (req, res) => {
    try {
        if (!ipv4Pool) {
            throw new Error('IPv4 pool not initialized');
        }

        const result = await testConnection(ipv4Pool, 'IPv4');
        res.json({
            timestamp: new Date().toISOString(),
            testResult: result
        });
    } catch (error) {
        res.status(500).json({
            error: 'IPv4 test failed',
            message: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// IPv6 test endpoint
app.get('/test-connections/ipv6', async (req, res) => {
    try {
        if (!ipv6Pool) {
            throw new Error('IPv6 pool not initialized');
        }

        const result = await testConnection(ipv6Pool, 'IPv6');
        res.json({
            timestamp: new Date().toISOString(),
            testResult: result
        });
    } catch (error) {
        res.status(500).json({
            error: 'IPv6 test failed',
            message: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// Dualstack test endpoint
app.get('/test-connections/dualstack', async (req, res) => {
    try {
        if (!ipv4Pool || !ipv6Pool) {
            throw new Error('Connection pools not initialized');
        }

        const [ipv4Result, ipv6Result] = await Promise.all([
            testConnection(ipv4Pool, 'IPv4'),
            testConnection(ipv6Pool, 'IPv6')
        ]);

        res.json({
            timestamp: new Date().toISOString(),
            testResults: {
                ipv4: ipv4Result,
                ipv6: ipv6Result
            }
        });
    } catch (error) {
        res.status(500).json({
            error: 'Dualstack test failed',
            message: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// Initialize the application
async function initialize() {
    try {
        await initializePools();
        const port = process.env.PORT || 3000;
        app.listen(port, () => {
            console.log(`Server running on port ${port}`);
            console.log('Environment:', {
                RDS_ENDPOINT: rdsEndpoint,
                PORT: port
            });
        });
    } catch (error) {
        console.error('Failed to initialize application:', error);
        process.exit(1);
    }
}

initialize();

// Cleanup on application shutdown
process.on('SIGINT', () => {
    ipv4Pool?.end();
    ipv6Pool?.end();
    process.exit();
});