/**
 * Repo Cleanup Audit
 * 
 * Deterministic audit tool that identifies files/folders likely unused (no inbound references)
 * without deleting or moving anything.
 * 
 * This script:
 * 1. Walks the repository (excluding build artifacts, node_modules, etc.)
 * 2. Builds a set of "tracked files" (all file paths discovered)
 * 3. Builds a set of "referenced files" by scanning:
 *    - TypeScript/JavaScript imports/require paths
 *    - package.json scripts strings
 *    - docs/PROJECT_LEDGER.md, docs/map_pipeline.md, docs/handoff_map_pipeline.md
 * 4. Classifies each file into USED, ORPHAN_CANDIDATE, or EXEMPT
 * 5. Outputs deterministic JSON and Markdown reports
 */

import { loadMistakes, assertNoRepeat, appendMistake } from "../../tools/assistant/mistake_guard";
loadMistakes();
assertNoRepeat("cleanup deletion must use git grep when rg is unavailable and must not run in a dirty working tree");
assertNoRepeat("do not commit cleanup audit output files; commit only minimal meaningful repo cleanup diffs");

import { readdir, readFile, writeFile, stat } from 'node:fs/promises';
import { resolve, relative, join, dirname, normalize, sep } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Deterministic: use posix-style paths internally for cross-platform consistency
function toPosixPath(path: string): string {
  return normalize(path).replace(/\\/g, '/');
}

// Deterministic: normalize repo-relative paths
function normalizeRepoPath(repoRoot: string, filePath: string): string {
  const rel = relative(repoRoot, filePath);
  return toPosixPath(rel);
}

interface FileClassification {
  path: string; // posix-style repo-relative path
  category: 'USED' | 'ORPHAN_CANDIDATE' | 'EXEMPT';
  reasons: string[];
}

// Exclude patterns (deterministic)
const EXCLUDE_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  '.git',
  '.cursor',
  '.vscode',
  'coverage',
  '.cache',
]);

// Exempt patterns (files that should never be flagged as orphans)
const EXEMPT_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  // Root config files
  { pattern: /^package\.json$/, reason: 'root config file' },
  { pattern: /^package-lock\.json$/, reason: 'root config file' },
  { pattern: /^tsconfig\.json$/, reason: 'root config file' },
  { pattern: /^\.gitignore$/, reason: 'root config file' },
  { pattern: /^\.gitattributes$/, reason: 'root config file' },
  { pattern: /^README\.md$/, reason: 'root documentation' },
  // All docs
  { pattern: /^docs\//, reason: 'documentation file' },
  // All data/source (read-only sources)
  { pattern: /^data\/source\//, reason: 'source data (read-only)' },
  // Canonical Phase 0 substrate paths (from ledger)
  { pattern: /^data\/derived\/settlements_substrate\.geojson$/, reason: 'canonical Phase 0 substrate' },
  { pattern: /^data\/derived\/settlements_substrate\.audit\.json$/, reason: 'canonical Phase 0 substrate audit' },
  { pattern: /^data\/derived\/settlements_substrate\.audit\.txt$/, reason: 'canonical Phase 0 substrate audit' },
  { pattern: /^data\/derived\/substrate_viewer\//, reason: 'canonical Phase 0 substrate viewer' },
  { pattern: /^scripts\/map\/derive_settlement_substrate_from_master\.ts$/, reason: 'canonical Phase 0 script' },
  { pattern: /^scripts\/map\/build_substrate_viewer_index\.ts$/, reason: 'canonical Phase 0 script' },
];

// Canonical data/derived artifacts (from ledger - these are outputs but canonical)
const CANONICAL_DERIVED = new Set([
  'data/derived/settlements_substrate.geojson',
  'data/derived/settlements_substrate.audit.json',
  'data/derived/settlements_substrate.audit.txt',
  'data/derived/substrate_viewer/index.html',
  'data/derived/substrate_viewer/viewer.js',
  'data/derived/substrate_viewer/data_index.json',
]);

async function walkDirectory(dir: string, repoRoot: string, files: Set<string>): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  
  // Deterministic: sort entries for stable traversal
  entries.sort((a, b) => a.name.localeCompare(b.name));
  
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    const relPath = normalizeRepoPath(repoRoot, fullPath);
    const pathParts = relPath.split('/');
    
    // Skip excluded directories
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry.name) || EXCLUDE_DIRS.has(pathParts[0])) {
        continue;
      }
      await walkDirectory(fullPath, repoRoot, files);
    } else {
      files.add(relPath);
    }
  }
}

// Extract import/require paths from TypeScript/JavaScript code
function extractImportPaths(content: string): Set<string> {
  const paths = new Set<string>();
  
  // ES module imports: import ... from "path" or import "path"
  const esImportRegex = /import\s+(?:.*\s+from\s+)?["']([^"']+)["']/g;
  let match;
  while ((match = esImportRegex.exec(content)) !== null) {
    const path = match[1];
    // Skip node_modules and absolute paths
    if (!path.startsWith('.') && !path.startsWith('/')) {
      continue; // Likely a package import
    }
    paths.add(path);
  }
  
  // CommonJS require: require("path")
  const requireRegex = /require\(["']([^"']+)["']\)/g;
  while ((match = requireRegex.exec(content)) !== null) {
    const path = match[1];
    if (!path.startsWith('.') && !path.startsWith('/')) {
      continue; // Likely a package import
    }
    paths.add(path);
  }
  
  return paths;
}

// Resolve relative import path to repo-relative file path
function resolveImportPath(importPath: string, fromFile: string, repoRoot: string): string | null {
  // Remove file extension if present
  let resolved = importPath;
  if (resolved.startsWith('./') || resolved.startsWith('../')) {
    const fromDir = dirname(fromFile);
    resolved = normalize(join(repoRoot, fromDir, resolved));
    resolved = relative(repoRoot, resolved);
    resolved = toPosixPath(resolved);
    
    // Try common extensions
    const extensions = ['.ts', '.js', '.tsx', '.jsx', ''];
    for (const ext of extensions) {
      const candidate = resolved + ext;
      if (existsSync(join(repoRoot, candidate))) {
        return candidate;
      }
    }
    
    // Try directory with index files
    const indexFiles = ['index.ts', 'index.js', 'index.tsx', 'index.jsx'];
    for (const indexFile of indexFiles) {
      const candidate = join(resolved, indexFile);
      if (existsSync(join(repoRoot, candidate))) {
        return toPosixPath(candidate);
      }
    }
    
    // If no extension works, return the path as-is (might be a directory/index we can't resolve)
    return resolved;
  }
  return null;
}

// Extract file paths from package.json scripts
function extractScriptPaths(packageJson: any): Set<string> {
  const paths = new Set<string>();
  
  if (!packageJson.scripts || typeof packageJson.scripts !== 'object') {
    return paths;
  }
  
  for (const script of Object.values(packageJson.scripts) as string[]) {
    if (typeof script !== 'string') continue;
    
    // Look for file paths in script strings
    // Patterns: tsx path/to/file.ts, node path/to/file.js, etc.
    const pathPatterns = [
      /(?:tsx|node|ts-node)\s+([^\s"']+\.(?:ts|js|tsx|jsx))/g,
      /["']([^\s"']+\.(?:ts|js|tsx|jsx|json|geojson|html|md))["']/g,
      /--input\s+([^\s"']+)/g,
      /--config\s+([^\s"']+)/g,
    ];
    
    for (const pattern of pathPatterns) {
      let match;
      while ((match = pattern.exec(script)) !== null) {
        const path = match[1];
        // Only include repo-relative paths (not absolute or node_modules)
        if (path.startsWith('.') || (!path.includes('node_modules') && !path.startsWith('/'))) {
          paths.add(toPosixPath(path));
        }
      }
    }
  }
  
  return paths;
}

// Extract file paths from markdown documentation
function extractDocPaths(content: string): Set<string> {
  const paths = new Set<string>();
  
  // Look for backtick-wrapped paths: `path/to/file.ext`
  const backtickRegex = /`([^\s`]+\.(?:ts|js|tsx|jsx|json|geojson|html|md|txt|py))`/g;
  let match;
  while ((match = backtickRegex.exec(content)) !== null) {
    const path = match[1];
    // Only include repo-relative paths
    if (path.startsWith('.') || (!path.includes('node_modules') && !path.startsWith('/'))) {
      paths.add(toPosixPath(path));
    }
  }
  
  // Look for markdown links: [text](path/to/file.ext)
  const linkRegex = /\]\(([^\s)]+\.(?:ts|js|tsx|jsx|json|geojson|html|md|txt|py))\)/g;
  while ((match = linkRegex.exec(content)) !== null) {
    const path = match[1];
    if (path.startsWith('.') || (!path.includes('node_modules') && !path.startsWith('/'))) {
      paths.add(toPosixPath(path));
    }
  }
  
  return paths;
}

async function main(): Promise<void> {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const repoRoot = resolve(__dirname, '../..');
  console.log(`Repository root: ${repoRoot}`);
  
  // Step 1: Walk repository and collect all files
  console.log('Walking repository...');
  const trackedFiles = new Set<string>();
  await walkDirectory(repoRoot, repoRoot, trackedFiles);
  console.log(`Found ${trackedFiles.size} tracked files`);
  
  // Step 2: Build referenced files set
  const referencedFiles = new Set<string>();
  
  // Scan TypeScript/JavaScript files for imports
  console.log('Scanning TypeScript/JavaScript files for imports...');
  const codeExtensions = new Set(['.ts', '.js', '.tsx', '.jsx']);
  let codeFilesScanned = 0;
  for (const file of trackedFiles) {
    if (!codeExtensions.has(file.substring(file.lastIndexOf('.')))) {
      continue;
    }
    
    try {
      const content = await readFile(join(repoRoot, file), 'utf8');
      const imports = extractImportPaths(content);
      
      for (const importPath of imports) {
        const resolved = resolveImportPath(importPath, file, repoRoot);
        if (resolved) {
          referencedFiles.add(resolved);
        }
      }
      
      codeFilesScanned++;
    } catch (err) {
      // Skip files that can't be read
      console.warn(`Warning: Could not read ${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log(`Scanned ${codeFilesScanned} code files, found ${referencedFiles.size} referenced paths from imports`);
  
  // Scan package.json scripts
  console.log('Scanning package.json scripts...');
  try {
    const packageJsonPath = join(repoRoot, 'package.json');
    const packageJsonContent = await readFile(packageJsonPath, 'utf8');
    const packageJson = JSON.parse(packageJsonContent);
    const scriptPaths = extractScriptPaths(packageJson);
    for (const path of scriptPaths) {
      referencedFiles.add(path);
    }
    console.log(`Found ${scriptPaths.size} paths in package.json scripts`);
  } catch (err) {
    console.warn(`Warning: Could not read package.json: ${err instanceof Error ? err.message : String(err)}`);
  }
  
  // Scan documentation files
  const docFiles = [
    'docs/PROJECT_LEDGER.md',
    'docs/map_pipeline.md',
    'docs/handoff_map_pipeline.md',
  ];
  
  console.log('Scanning documentation files...');
  for (const docFile of docFiles) {
    const docPath = join(repoRoot, docFile);
    if (!existsSync(docPath)) {
      console.log(`  Skipping ${docFile} (not found)`);
      continue;
    }
    
    try {
      const content = await readFile(docPath, 'utf8');
      const docPaths = extractDocPaths(content);
      for (const path of docPaths) {
        referencedFiles.add(path);
      }
      console.log(`  Found ${docPaths.size} paths in ${docFile}`);
    } catch (err) {
      console.warn(`Warning: Could not read ${docFile}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  
  console.log(`Total referenced files: ${referencedFiles.size}`);
  
  // Step 3: Classify files
  console.log('Classifying files...');
  const classifications: FileClassification[] = [];
  
  // Deterministic: sort files for stable output
  const sortedFiles = Array.from(trackedFiles).sort();
  
  for (const file of sortedFiles) {
    // Check if exempt
    let isExempt = false;
    let exemptReason = '';
    for (const { pattern, reason } of EXEMPT_PATTERNS) {
      if (pattern.test(file)) {
        isExempt = true;
        exemptReason = reason;
        break;
      }
    }
    
    if (isExempt) {
      classifications.push({
        path: file,
        category: 'EXEMPT',
        reasons: [exemptReason],
      });
      continue;
    }
    
    // Check if referenced
    const isReferenced = referencedFiles.has(file);
    
    if (isReferenced) {
      classifications.push({
        path: file,
        category: 'USED',
        reasons: ['found in referenced files set'],
      });
    } else {
      classifications.push({
        path: file,
        category: 'ORPHAN_CANDIDATE',
        reasons: ['no inbound reference found'],
      });
    }
  }
  
  // Step 4: Generate reports
  const outputDir = join(repoRoot, 'docs/cleanup');
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }
  
  // Generate JSON report (deterministic: sorted)
  const jsonReport = {
    summary: {
      total_files: classifications.length,
      used: classifications.filter(c => c.category === 'USED').length,
      orphan_candidates: classifications.filter(c => c.category === 'ORPHAN_CANDIDATE').length,
      exempt: classifications.filter(c => c.category === 'EXEMPT').length,
    },
    files: classifications.sort((a, b) => {
      // Sort by category first, then path
      if (a.category !== b.category) {
        const order = { 'USED': 0, 'EXEMPT': 1, 'ORPHAN_CANDIDATE': 2 };
        return (order[a.category] || 999) - (order[b.category] || 999);
      }
      return a.path.localeCompare(b.path);
    }),
  };
  
  const jsonPath = join(outputDir, 'cleanup_audit.json');
  await writeFile(jsonPath, JSON.stringify(jsonReport, null, 2), 'utf8');
  console.log(`Wrote JSON report: ${jsonPath}`);
  
  // Generate Markdown report
  const orphanCandidates = classifications.filter(c => c.category === 'ORPHAN_CANDIDATE');
  
  // Group by directory
  const byDir = new Map<string, FileClassification[]>();
  for (const file of orphanCandidates) {
    const dir = dirname(file.path) || '.';
    if (!byDir.has(dir)) {
      byDir.set(dir, []);
    }
    byDir.get(dir)!.push(file);
  }
  
  // Sort directories
  const sortedDirs = Array.from(byDir.keys()).sort();
  
  let mdContent = `# Repo Cleanup Audit Report

## Summary

- **Total files scanned:** ${jsonReport.summary.total_files}
- **Used files:** ${jsonReport.summary.used}
- **Orphan candidates:** ${jsonReport.summary.orphan_candidates}
- **Exempt files:** ${jsonReport.summary.exempt}

## Orphan Candidates

Files that appear to have no inbound references (imports, requires, package.json scripts, or documentation mentions).

### By Directory

`;

  for (const dir of sortedDirs) {
    const files = byDir.get(dir)!;
    files.sort((a, b) => a.path.localeCompare(b.path));
    
    mdContent += `#### \`${dir}\` (${files.length} file${files.length !== 1 ? 's' : ''})\n\n`;
    
    for (const file of files) {
      mdContent += `- \`${file.path}\`\n`;
      for (const reason of file.reasons) {
        mdContent += `  - ${reason}\n`;
      }
    }
    
    mdContent += '\n';
  }
  
  if (orphanCandidates.length === 0) {
    mdContent += 'No orphan candidates found.\n';
  }
  
  mdContent += `\n## Notes

- This audit is **deterministic** (stable output on repeated runs)
- Files are classified as:
  - **USED**: Found in referenced files set (imports, requires, scripts, docs)
  - **ORPHAN_CANDIDATE**: No inbound reference found
  - **EXEMPT**: Explicitly excluded from orphan detection (config files, docs, source data, canonical Phase 0 artifacts)
- This audit does **not** delete or move any files
- Review orphan candidates manually before deletion
- Some files may be referenced in ways not detected by this audit (e.g., dynamic imports, string concatenation, external tools)
`;

  const mdPath = join(outputDir, 'cleanup_audit.md');
  await writeFile(mdPath, mdContent, 'utf8');
  console.log(`Wrote Markdown report: ${mdPath}`);
  
  console.log('\nAudit complete!');
  console.log(`  Orphan candidates: ${orphanCandidates.length}`);
  console.log(`  Reports written to: docs/cleanup/`);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
