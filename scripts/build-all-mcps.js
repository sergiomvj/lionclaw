const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const mcpDir = path.join(__dirname, '..', 'mcp-servers');

if (!fs.existsSync(mcpDir)) {
  console.log('Pasta mcp-servers/ nao encontrada. Pulando build de MCPs.');
  process.exit(0);
}

const dirs = fs.readdirSync(mcpDir).filter(d =>
  fs.statSync(path.join(mcpDir, d)).isDirectory()
);

let success = 0;
let failed = 0;
let skipped = 0;

for (const dir of dirs) {
  const fullPath = path.join(mcpDir, dir);
  const pkgPath = path.join(fullPath, 'package.json');

  if (!fs.existsSync(pkgPath)) {
    skipped++;
    continue;
  }

  // Only build if there's a src/index.ts (actual MCP server, not a shared lib)
  const srcIndex = path.join(fullPath, 'src', 'index.ts');
  if (!fs.existsSync(srcIndex)) {
    console.log(`  SKIP ${dir} (no src/index.ts — shared lib?)`);
    skipped++;
    continue;
  }

  console.log(`Building MCP: ${dir}...`);
  try {
    execSync('npm install --no-audit --no-fund && npm run build', {
      cwd: fullPath,
      stdio: 'inherit',
      timeout: 120000,
    });
    console.log(`  OK ${dir}`);
    success++;
  } catch (e) {
    console.error(`  FAIL ${dir}: ${e.message}`);
    failed++;
  }
}

console.log(`\nMCP Build: ${success} ok, ${failed} failed, ${skipped} skipped`);

if (failed > 0) {
  process.exit(1);
}
