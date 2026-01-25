const AdmZip = require('adm-zip');
const zip = new AdmZip('data/source/settlements_pack.zip');
const entry = zip.getEntry('Zvornik_20168.js');
if (entry) {
  const content = entry.getData().toString('utf8');
  console.log('File length:', content.length);
  
  // Try to find R.path calls
  const pathPattern = /R\.path\s*\(\s*["']([^"']+)["']/g;
  let match;
  let count = 0;
  const paths = [];
  while ((match = pathPattern.exec(content)) !== null && count < 5) {
    paths.push(match[1]);
    console.log('Path', count+1, ':', match[1].substring(0, 100));
    count++;
  }
  console.log('Total paths found:', paths.length);
  
  // Look for settlement IDs or names
  const sidPattern = /\d{6,}/g;
  const sids = content.match(sidPattern);
  if (sids) {
    console.log('Potential SIDs (first 10):', sids.slice(0, 10));
  }
  
  // Look for variable names that might indicate settlements
  const varPattern = /var\s+(\w+)\s*=/g;
  const vars = [];
  let varMatch;
  while ((varMatch = varPattern.exec(content)) !== null && vars.length < 20) {
    vars.push(varMatch[1]);
  }
  console.log('Variables (first 20):', vars);
}
