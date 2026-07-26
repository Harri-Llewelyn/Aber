import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const envPath = path.join(rootDir, '.env');
const envExamplePath = path.join(rootDir, '.env.example');

console.log('🚀 Running Factory+ Asset Tracking Environment Setup...');

// 1. Ensure .env exists
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

// 2. Try querying Supabase CLI status if active
try {
  const statusOutput = execSync('npx supabase status -o json', {
    cwd: rootDir,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore']
  });

  const status = JSON.parse(statusOutput);
  let envContent = fs.readFileSync(envPath, 'utf-8');

  const apiUrl = status.API_URL || status.API_URL || 'http://127.0.0.1:54321';
  const anonKey = status.ANON_KEY;
  const serviceRoleKey = status.SERVICE_ROLE_KEY;

  if (apiUrl) {
    envContent = envContent.replace(/^SUPABASE_URL=.*/m, `SUPABASE_URL=${apiUrl}`);
  }
  if (anonKey) {
    envContent = envContent.replace(/^SUPABASE_ANON_KEY=.*/m, `SUPABASE_ANON_KEY=${anonKey}`);
  }
  if (serviceRoleKey) {
    envContent = envContent.replace(/^SUPABASE_SERVICE_ROLE_KEY=.*/m, `SUPABASE_SERVICE_ROLE_KEY=${serviceRoleKey}`);
  }

  fs.writeFileSync(envPath, envContent, 'utf-8');
  console.log('✅ Synchronized active Supabase API keys into .env');
} catch (err) {
  console.log('ℹ️  Supabase CLI stack not active (or using unified Docker Compose). Using default .env configuration.');
}

console.log('🎉 Setup complete! Run `docker compose up --build -d` to launch the application.');
