require('dotenv').config();
const cloudinary = require('cloudinary').v2;

const CLOUDINARY_ENABLED = !!(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET);
console.log('CLOUDINARY_ENABLED:', CLOUDINARY_ENABLED);
if (!CLOUDINARY_ENABLED) {
  console.error('Cloudinary not configured in .env!');
  process.exit(1);
}

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true
});

// A tiny 1x1 pixel base64 GIF
const base64Gif = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

async function run() {
  try {
    console.log('Testing upload...');
    const result = await cloudinary.uploader.upload(base64Gif, {
      folder: 'test_folder',
      public_id: `test_image_${Date.now()}`
    });
    console.log('Upload success! Secure URL:', result.secure_url);
  } catch (err) {
    console.error('Upload failed:', err);
  }
}

run();
