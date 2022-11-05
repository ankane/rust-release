const fs = require('fs');
const os = require('os');
const path = require('path');
const spawnSync = require('child_process').spawnSync;

function run(...args) {
  runOptions({}, ...args);
}

function runOptions(options, command, ...args) {
  options.stdio ??= 'inherit';
  console.log(`${command} ${args.join(' ')}`);
  // spawn is safer and more lightweight than exec
  const ret = spawnSync(command, args, options);
  if (ret.status !== 0) {
    throw ret.error;
  }
}

function capture(command, ...args) {
  return spawnSync(command, args, {stdio: ['pipe', 'pipe', 'inherit']}).stdout;
}

function isMac() {
  return process.platform == 'darwin';
}

function isWindows() {
  return process.platform == 'win32';
}

function addOutput(key, value) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
}

let name = process.env['INPUT_NAME'];
let version = process.env['INPUT_VERSION'];
const appPath = process.env['INPUT_PATH'];
const target = process.env['INPUT_TARGET'];

if (target == 'aarch64-unknown-linux-gnu') {
  run('sudo', 'apt', 'update');
  run('sudo', 'apt', 'install', 'gcc-aarch64-linux-gnu');
  process.env['CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER'] = 'aarch64-linux-gnu-gcc';
}

run('rustup', 'target', 'add', target);

const cwd = process.cwd();
if (appPath) {
  process.chdir(appPath);
}

// TODO support features
// TODO use --out-dir when stable
run('cargo', 'build', '--release', '--target', target);

const metadata = JSON.parse(capture('cargo', 'metadata', '--format-version', '1', '--no-deps'));
const package = metadata['packages'][0];

if (!name) {
  name = package.name;
}
if (!version) {
  version = package.version;
}

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-'));
const unarchiveName = `${name}-${version}`;
const dir = path.join(tempDir, unarchiveName);
fs.mkdirSync(dir);

for (let t of package.targets) {
  let kind = t.kind[0];
  if (kind == 'bin') {
    let bin = t.name;
    if (isWindows()) {
      bin += '.exe';
    }
    fs.copyFileSync(`target/${target}/release/${bin}`, `${dir}/${bin}`);
  } else if (kind == 'cdylib') {
    let lib;
    if (isWindows()) {
      lib = `${t.name}.dll`;
    } else if (isMac()) {
      lib = `lib${t.name}.dylib`;
    } else {
      lib = `lib${t.name}.so`;
    }
    fs.mkdirSync(`${dir}/lib`, {recursive: true});
    fs.copyFileSync(`target/${target}/release/${lib}`, `${dir}/lib/${lib}`);

    if (fs.existsSync('include') && !fs.existsSync(`${dir}/include`)) {
      fs.cpSync('include', `${dir}/include`, {recursive: true});
    }
  }
}

let files = fs.readdirSync('.');
for (let file of files) {
  if (/readme|license|notice/i.test(file)) {
    fs.copyFileSync(file, `${dir}/${file}`);
  }
}

// TODO support wildcards
let extraFiles = process.env['INPUT_FILES'];
if (extraFiles) {
  extraFiles = extraFiles.trim().split('\n');
  for (let file of extraFiles) {
    fs.cpSync(file, `${dir}/${file}`, {recursive: true});
  }
}

let thirdPartyPath = path.join(dir, 'LICENSE-THIRD-PARTY');

if (package.dependencies.length > 0) {
  // TODO use binary
  run('cargo', 'install', 'cargo-3pl', '--force');

  // TODO pass features
  const thirdPartyLicenses = capture('cargo', '3pl');
  fs.appendFileSync(thirdPartyPath, thirdPartyLicenses);
}

let manualLicensesPath = process.env['INPUT_MANUAL-LICENSES-PATH'];
if (manualLicensesPath) {
  const manualLicenses = fs.readFileSync(manualLicensesPath);
  fs.appendFileSync(thirdPartyPath, manualLicenses);
}

process.chdir(cwd);

const artifactExt = isWindows() ? 'zip' : 'tar.gz';
const artifactName = `${name}-${version}-${target}.${artifactExt}`;
const artifactPath = path.join(tempDir, artifactName);

if (isWindows()) {
  runOptions({'shell':'powershell.exe'}, 'Compress-Archive', '-Path', dir, '-DestinationPath', artifactPath);
} else {
  run('tar', 'czf', artifactPath, '-C', tempDir, unarchiveName);
}

addOutput('artifact-name', artifactName);
addOutput('artifact-path', artifactPath);
