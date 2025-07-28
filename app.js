const express = require('express');
const mysql = require('mysql2');
const dns = require('dns').promises;

const app = express();

// Configuration
const dbConfig = {
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || 'iluvVtoN',
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
                console.error(`${version} connection failed:`, err);
                return resolve({
                    success: false,
                    error: err.message,
                    details: {
                        code: err.code,
                        errno: err.errno
                    }
                });
            }

            // Test basic connectivity
            connection.query('SELECT 1 as test', (error, testResult) => {
                connection.release();
                if (error) {
                    return resolve({
                        success: false,
                        error: error.message,
                        details: {
                            code: error.code,
                            errno: error.errno
                        }
                    });
                }

                resolve({
                    success: true,
                    data: {
                        test: testResult
                    }
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

        // Initialize IPv6 pool
        ipv6Pool = createPool(addresses.ipv6, 'IPv6');

        console.log('Connection pools initialized successfully');
    } catch (error) {
        console.error('Failed to initialize pools:', error);
        throw error;
    }
}

async function resolveHostname(hostname) {
    try {
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
    res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Test endpoint based on TEST_MODE environment variable
app.get('/', async (req, res) => {
    try {
        const testMode = process.env.TEST_MODE || 'ipv4'; // Default to IPv4 if not specified
        
        switch (testMode.toLowerCase()) {
            case 'ipv4':
                if (!ipv4Pool) {
                    throw new Error('IPv4 pool not initialized');
                }
                
                const ipv4Result = await testConnection(ipv4Pool, 'IPv4');
                res.json({ 
                    testMode: 'IPv4',
                    message: ipv4Result.success ? "Test Successful" : "Test Failed",
                    timestamp: new Date().toISOString(), 
                    testResult: ipv4Result 
                });
                break;
                
            case 'ipv6':
                if (!ipv6Pool) {
                    throw new Error('IPv6 pool not initialized');
                }
                
                const ipv6Result = await testConnection(ipv6Pool, 'IPv6');
                res.json({ 
                    testMode: 'IPv6',
                    message: ipv6Result.success ? "Test Successful" : "Test Failed",
                    timestamp: new Date().toISOString(), 
                    testResult: ipv6Result 
                });
                break;
                
            case 'dualstack':
                if (!ipv4Pool || !ipv6Pool) {
                    throw new Error('Connection pools not initialized');
                }
                
                const [dualIpv4Result, dualIpv6Result] = await Promise.all([
                    testConnection(ipv4Pool, 'IPv4'),
                    testConnection(ipv6Pool, 'IPv6')
                ]);
                
                res.json({
                    testMode: 'Dualstack',
                    message: (dualIpv4Result.success && dualIpv6Result.success) ? "Test Successful" : "Test Failed",
                    timestamp: new Date().toISOString(),
                    testResults: { ipv4: dualIpv4Result, ipv6: dualIpv6Result }
                });
                break;
                
            default:
                res.status(400).json({
                    message: "Invalid TEST_MODE. Use 'ipv4', 'ipv6', or 'dualstack'",
                    timestamp: new Date().toISOString(),
                    currentTestMode: testMode
                });
                return;
        }

    } catch (error) {
        res.status(500).json({ 
            message: "Test Failed",
            timestamp: new Date().toISOString(), 
            error: error.message,
            testMode: process.env.TEST_MODE || 'ipv4'
        });
    }
});

// Initialize the application
async function initialize() {
    try {
        await initializePools();
        const port = process.env.PORT || 3000;
        app.listen(port, () => console.log(`Server running on port ${port}`));
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