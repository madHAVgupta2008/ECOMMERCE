/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║       CLOUDINARY MIGRATION SCRIPT — RakhiRoots              ║
 * ║  Moves all base64 images from MongoDB → Cloudinary CDN       ║
 * ║                                                              ║
 * ║  HOW TO RUN:                                                 ║
 * ║  1. node scripts/migrate-to-cloudinary.js --dry-run          ║
 * ║     (shows what WILL happen, changes nothing)                ║
 * ║  2. node scripts/migrate-to-cloudinary.js                    ║
 * ║     (actually migrates!)                                     ║
 * ╚══════════════════════════════════════════════════════════════╝
 */

require('dotenv').config();
const mongoose = require('mongoose');
const cloudinary = require('cloudinary').v2;
const Product = require('../models/Product');

// ── Configuration ──────────────────────────────────────────────
const DRY_RUN = process.argv.includes('--dry-run');
const BATCH_SIZE = 5; // Process 5 products at a time to keep memory low

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true
});

// ── Helpers ────────────────────────────────────────────────────
const log  = (msg) => console.log(`  ${msg}`);
const ok   = (msg) => console.log(`  ✅ ${msg}`);
const warn = (msg) => console.log(`  ⚠️  ${msg}`);
const err  = (msg) => console.log(`  ❌ ${msg}`);
const sep  = ()    => console.log('─'.repeat(60));

/**
 * Uploads a base64 data-URI to Cloudinary.
 * Returns the secure HTTPS URL.
 */
async function uploadBase64ToCloudinary(base64DataUri, productId, imageIndex) {
  const result = await cloudinary.uploader.upload(base64DataUri, {
    folder: 'rakhiroots/products',
    public_id: `${productId}_img${imageIndex}`,
    overwrite: true,
    resource_type: 'image',
    quality: 'auto:good',
    fetch_format: 'auto'
  });
  return result.secure_url;
}

// ── Main Migration ─────────────────────────────────────────────
async function migrate() {
  console.log('\n');
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║         RakhiRoots → Cloudinary Image Migration             ║');
  if (DRY_RUN) {
  console.log('║                    *** DRY RUN MODE ***                      ║');
  }
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log();

  // Validate env vars
  const missingVars = [];
  if (!process.env.MONGO_URI)              missingVars.push('MONGO_URI');
  if (!process.env.CLOUDINARY_CLOUD_NAME)  missingVars.push('CLOUDINARY_CLOUD_NAME');
  if (!process.env.CLOUDINARY_API_KEY)     missingVars.push('CLOUDINARY_API_KEY');
  if (!process.env.CLOUDINARY_API_SECRET)  missingVars.push('CLOUDINARY_API_SECRET');

  if (missingVars.length) {
    err(`Missing environment variables: ${missingVars.join(', ')}`);
    console.log('\n  Fill these in your .env file first.\n');
    process.exit(1);
  }

  // Connect to MongoDB
  log('Connecting to MongoDB...');
  await mongoose.connect(process.env.MONGO_URI);
  ok('MongoDB connected');
  sep();

  // Count total products WITHOUT loading their image data
  const totalCount = await Product.countDocuments();
  log(`Found ${totalCount} products total`);
  log(`Processing in batches of ${BATCH_SIZE} to keep memory low...`);
  sep();

  let totalImages = 0;
  let migratedImages = 0;
  let skippedImages = 0;
  let failedImages = 0;
  let productsUpdated = 0;
  let productIndex = 0;

  // Process products in small batches — never loads all 106 at once
  for (let skip = 0; skip < totalCount; skip += BATCH_SIZE) {
    // Load only BATCH_SIZE products at a time, including images
    const batch = await Product.find().skip(skip).limit(BATCH_SIZE);

    for (const product of batch) {
      productIndex++;
      console.log(`\n[${productIndex}/${totalCount}] "${product.name}" (${product.itemCode || 'no code'})`);

      if (!product.images || product.images.length === 0) {
        warn('No images — skipping');
        // Free memory immediately
        product.images = [];
        continue;
      }

      let changed = false;
      const newImages = [];

      for (let j = 0; j < product.images.length; j++) {
        const img = product.images[j];
        totalImages++;

        // Already a Cloudinary or external URL — skip
        if (typeof img === 'string' && (img.startsWith('https://res.cloudinary.com') || img.startsWith('http'))) {
          log(`  Image ${j + 1}: already a URL — skipping`);
          newImages.push(img);
          skippedImages++;
          continue;
        }

        // It's a base64 string — upload to Cloudinary
        if (typeof img === 'string' && img.startsWith('data:')) {
          const sizeKB = Math.round(img.length * 0.75 / 1024);
          log(`  Image ${j + 1}: base64 (${sizeKB} KB) → uploading to Cloudinary...`);

          if (DRY_RUN) {
            log(`  [DRY RUN] Would upload image ${j + 1} of "${product.name}"`);
            newImages.push('__would_upload__');
            migratedImages++;
          } else {
            try {
              const cloudUrl = await uploadBase64ToCloudinary(img, product.id, j);
              ok(`  Image ${j + 1}: uploaded → ${cloudUrl}`);
              newImages.push(cloudUrl);
              migratedImages++;
              changed = true;
            } catch (uploadErr) {
              err(`  Image ${j + 1}: upload FAILED — ${uploadErr.message}`);
              newImages.push(img); // Keep original on failure
              failedImages++;
            }
          }
        } else {
          warn(`  Image ${j + 1}: unknown format — skipping`);
          newImages.push(img);
          skippedImages++;
        }
      }

      // Save updated product to MongoDB
      if (changed && !DRY_RUN) {
        product.images = newImages;
        await product.save();
        ok(`  Product saved with ${newImages.length} Cloudinary URLs`);
        productsUpdated++;
      }

      // Free this product's images from memory before loading next batch
      product.images = [];
    }

    // Hint to Node.js garbage collector after each batch
    if (global.gc) global.gc();
  }

  // ── Summary ────────────────────────────────────────────────
  sep();
  console.log('\n📊 MIGRATION SUMMARY');
  sep();
  console.log(`  Total products:        ${totalCount}`);
  console.log(`  Total images found:    ${totalImages}`);
  if (DRY_RUN) {
    console.log(`  Would migrate:         ${migratedImages} base64 images`);
    console.log(`  Would skip (URL):      ${skippedImages} images`);
    console.log('\n  ✨ This was a DRY RUN — nothing was changed.');
    console.log('  Run without --dry-run to perform the actual migration.\n');
  } else {
    console.log(`  ✅ Migrated:           ${migratedImages} images`);
    console.log(`  ⏭️  Skipped (URL):      ${skippedImages} images`);
    console.log(`  ❌ Failed:             ${failedImages} images`);
    console.log(`  📦 Products updated:   ${productsUpdated}`);
    if (failedImages > 0) {
      console.log('\n  ⚠️  Some images failed. Run the script again to retry them.');
    } else {
      console.log('\n  🎉 Migration complete! All images are now on Cloudinary.');
    }
  }
  sep();

  await mongoose.disconnect();
  console.log('\n  MongoDB disconnected. Done.\n');
}

migrate().catch((e) => {
  console.error('\n❌ Fatal error during migration:', e.message);
  console.error(e);
  mongoose.disconnect();
  process.exit(1);
});
