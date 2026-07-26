import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const envPath = path.join(rootDir, '.env');
const envExamplePath = path.join(rootDir, '.env.example');

console.log('🚀 Running Factory+ Asset Tracking Environment Setup...');

// Ensure .env exists
if (!fs.existsSync(envPath)) {
  if (fs.existsSync(envExamplePath)) {
    fs.copyFileSync(envExamplePath, envPath);
    console.log('✅ Created .env from .env.example');
  } else {
    console.error('❌ Error: .env.example file not found.');
    process.exit(1);
  }
} else {
  console.log('ℹ️  Using existing .env file');
}

console.log('🎉 Environment file ready. Edit .env if you need to override any defaults, then run `docker compose up --build -d`.');
