import fs from 'node:fs';

const packagePath = 'apps/core/package.json';
const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
if (packageJson.version !== '0.48.0' && packageJson.version !== '0.49.0') {
  throw new Error(`unexpected Core package version ${packageJson.version}`);
}
packageJson.version = '0.49.0';
fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);

const checkPath = 'apps/core/scripts/check-openapi.mjs';
let check = fs.readFileSync(checkPath, 'utf8');
const versionOld = 'document.info?.version !== "0.48.0"';
const versionNew = 'document.info?.version !== "0.49.0"';
if (check.includes(versionOld)) check = check.replace(versionOld, versionNew);
if (!check.includes(versionNew)) throw new Error('Kernel OpenAPI version guard was not updated');

const inventoryPath = '  "/api/v1/me/_discovery/inventory",\n';
const configurationPaths = '  "/api/v1/me/_discovery/models",\n  "/api/v1/me/_discovery/models/{modelKey}",\n';
if (!check.includes(configurationPaths)) {
  if (!check.includes(inventoryPath)) throw new Error('Runtime Discovery inventory guard anchor not found');
  check = check.replace(inventoryPath, inventoryPath + configurationPaths);
}
fs.writeFileSync(checkPath, check);

const personCheckPath = 'apps/core/scripts/check-person-directory-openapi.mjs';
let personCheck = fs.readFileSync(personCheckPath, 'utf8');
const personVersionOld = 'document.info?.version !== "0.48.0"';
const personVersionNew = 'document.info?.version !== "0.49.0"';
const personMessageOld = 'Person Directory requires Core Kernel 0.48.0';
const personMessageNew = 'Person Directory requires Core Kernel 0.49.0';
if (personCheck.includes(personVersionOld)) personCheck = personCheck.replace(personVersionOld, personVersionNew);
if (personCheck.includes(personMessageOld)) personCheck = personCheck.replace(personMessageOld, personMessageNew);
if (!personCheck.includes(personVersionNew) || !personCheck.includes(personMessageNew)) {
  throw new Error('Person Directory Kernel version guard was not updated');
}
fs.writeFileSync(personCheckPath, personCheck);
