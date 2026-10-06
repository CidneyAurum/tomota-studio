const {createHash} = require('node:crypto');
const {readFileSync, readdirSync} = require('node:fs');
const {join, relative} = require('node:path');

// Compute once at process startup. A running backend must keep its original
// identity even if an upgrade later replaces the files on disk.
function runtimeBuildId(application, source = false) {
  const paths = [];
  function walk(directory) {
    for (const entry of readdirSync(directory, {withFileTypes: true})) {
      if (entry.name === '__pycache__' || entry.name.endsWith('.pyc') || entry.name.endsWith('.map')) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) paths.push(path);
      else throw new Error('Runtime identity refuses linked application files');
    }
  }
  for (const directory of ['src/tomota', 'skills/webnovel-writing', source ? 'studio/src' : 'studio/dist', source ? 'studio/server' : 'studio/dist-server']) walk(join(application, directory));
  for (const file of ['scripts/runtime_identity.cjs', 'scripts/fanqie_browser_driver.mjs', 'studio/node_modules/playwright-core/package.json']) paths.push(join(application, file));
  const hash = createHash('sha256').update(source ? 'tomota-source-v1\0' : 'tomota-runtime-v1\0');
  for (const path of paths.sort()) {
    hash.update(relative(application, path).replaceAll('\\', '/') + '\0');
    hash.update(createHash('sha256').update(readFileSync(path)).digest());
  }
  return hash.digest('hex');
}
module.exports = {runtimeBuildId};
