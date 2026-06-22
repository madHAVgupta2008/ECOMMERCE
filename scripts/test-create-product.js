require('dotenv').config();
const http = require('http');

const PORT = process.env.PORT || 3000;
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '956002';

// A tiny 1x1 pixel base64 GIF
const base64Gif = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

function httpRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          data: data
        });
      });
    });

    req.on('error', (err) => {
      reject(err);
    });

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

async function test() {
  try {
    console.log('Logging in to get admin token...');
    const loginPayload = { username: ADMIN_USERNAME, password: ADMIN_PASSWORD };
    const loginRes = await httpRequest({
      hostname: 'localhost',
      port: PORT,
      path: '/api/admin/login',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      }
    }, loginPayload);

    if (loginRes.statusCode !== 200) {
      throw new Error(`Login failed with status ${loginRes.statusCode}: ${loginRes.data}`);
    }

    const { token } = JSON.parse(loginRes.data);
    console.log('Login successful! Token acquired.');

    const uniqueCode = 'TEST-' + Math.floor(Math.random() * 100000);
    const payload = {
      name: 'Test Rakhi',
      price: '199',
      oldPrice: '299',
      category: 'Lumba',
      stock: '10',
      desc: 'Beautiful test rakhi',
      itemCode: uniqueCode,
      colors: ['Red', 'Gold'],
      images: [base64Gif]
    };

    console.log(`Sending POST /api/products with itemCode: ${uniqueCode}...`);
    const postRes = await httpRequest({
      hostname: 'localhost',
      port: PORT,
      path: '/api/products',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      }
    }, payload);

    console.log('Response Status:', postRes.statusCode);
    const postData = JSON.parse(postRes.data);
    console.log('Response Body:', postData);

    if (postRes.statusCode === 200 && !postData.error) {
      console.log('✅ Product created successfully!');
    } else {
      console.error('❌ Product creation failed:', postData.error || postData);
    }
  } catch (err) {
    console.error('Test failed with error:', err.message);
  }
}

test();
