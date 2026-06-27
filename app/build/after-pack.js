// re-sign the bundle ad-hoc AFTER electron-builder copies extraResources.
// builder signs first, then drops ~600MB of BMW data into Contents/Resources,
// which invalidates the seal and makes macOS report the app as "damaged".
// signing here, last, makes the seal match the final contents.
const { execFileSync } = require('child_process');
const path = require('path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
  console.log(`  • re-signed ${appName}.app ad-hoc after resources`);
};
