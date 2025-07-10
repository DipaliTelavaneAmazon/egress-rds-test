const express = require('express');
const mysql = require('mysql2/promise');
const dns = require('dns').promises;

const app = express();

// Configuration from environment variables
const dbConfig = {
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: 'V2NCanaryDB',
    port: 3306
};

// Get the RDS cluster endpoint from environment variable
const rdsEndpoint = process.env.RDS_ENDPOINT;

async function resolveHostname(hostname) {
    try {
        // Resolve IPv4 addresses
        const ipv4Addresses = await dns.resolve4(hostname);
        console.log('IPv4 addresses:', ipv4Addresses);

        // Resolve IPv6 addresses
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

async function testConnection(host, version) {
    const connectionConfig = {
        ...dbConfig,
        host: version === 'IPv6' ? `[${host}]` : host
    };

    try {
        console.log(`Attempting ${version} connection to: ${host}`);
        const connection = await mysql.createConnection(connectionConfig);
        
        // Test query
        const [rows] = await connection.execute('SELECT 1 as test');
        console.log(`${version} connection successful:`, rows);

        // Test query to get connection info
        const [connectionInfo] = await connection.execute('SELECT @@hostname, @@port, DATABASE()');
        console.log(`${version} connection details:`, connectionInfo);

        await connection.end();
        return {
            success: true,
            data: {
                test: rows,
                connectionInfo
            }
        };
    } catch (error) {
        console.error(`${version} connection failed:`, error);
        return {
            success: false,
            error: error.message
        };
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
        const addresses = await resolveHostname(rdsEndpoint);
        const result = await testConnection(addresses.ipv4, 'IPv4');
        res.json({
            timestamp: new Date().toISOString(),
            ipv4Address: addresses.ipv4,
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
        const addresses = await resolveHostname(rdsEndpoint);
        const result = await testConnection(addresses.ipv6, 'IPv6');
        res.json({
            timestamp: new Date().toISOString(),
            ipv6Address: addresses.ipv6,
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
        const addresses = await resolveHostname(rdsEndpoint);
        
        // Run both IPv4 and IPv6 tests in parallel
        const [ipv4Result, ipv6Result] = await Promise.all([
            testConnection(addresses.ipv4, 'IPv4'),
            testConnection(addresses.ipv6, 'IPv6')
        ]);

        res.json({
            timestamp: new Date().toISOString(),
            addresses: {
                ipv4: addresses.ipv4,
                ipv6: addresses.ipv6
            },
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

// Error handling
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Start server
const port = process.env.PORT || 3000;
app.listen(port, () => {
    console.log(`Server running on port ${port}`);
    console.log('Environment:', {
        RDS_ENDPOINT: rdsEndpoint,
        DB_USER: dbConfig.user,
        PORT: port
    });
});