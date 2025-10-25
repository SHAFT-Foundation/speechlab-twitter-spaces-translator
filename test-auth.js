#!/usr/bin/env node

/**
 * Quick test script to verify Twitter OAuth 1.0a authentication
 * Tests GET /2/users/me endpoint
 */

const { TwitterApi } = require('twitter-api-v2');

const client = new TwitterApi({
    appKey: '0R0xlZ156mmwfHsZvc2y4SmtD',
    appSecret: 'Bu6t5K0Fa65yNBdXVlyKMlB4O66nxeYAdzEaLUZ064DankJXBi',
    accessToken: '1865847011053879296-FezOqjGXi3X3KQxJPZcH50mrKMFHJc',
    accessSecret: 'q2zxyHvHV6IKm7vf3EFbgur4mBeFuHo3hxCsrI6Reqgv4',
});

async function testAuth() {
    console.log('Testing Twitter OAuth 1.0a authentication...');
    console.log('Endpoint: GET /2/users/me');
    console.log('');

    try {
        const me = await client.v2.me();
        console.log('✅ SUCCESS! Authentication working.');
        console.log('');
        console.log('User Details:');
        console.log(`  ID: ${me.data.id}`);
        console.log(`  Username: @${me.data.username}`);
        console.log(`  Name: ${me.data.name}`);
        console.log('');
        process.exit(0);
    } catch (error) {
        console.error('❌ AUTHENTICATION FAILED');
        console.error('');
        console.error('Error Details:');
        console.error(`  Code: ${error.code}`);
        console.error(`  Message: ${error.message}`);
        console.error('');

        if (error.data) {
            console.error('Error Data:', JSON.stringify(error.data, null, 2));
        }

        if (error.rateLimit) {
            console.error('Rate Limit Info:', error.rateLimit);
        }

        console.error('');
        console.error('Full Error:', error);
        process.exit(1);
    }
}

testAuth();
