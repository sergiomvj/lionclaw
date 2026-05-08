import { app } from 'electron';
import packageJson from '../../package.json';

const PACKAGE_VERSION = packageJson.version;

export function getAppVersion(): string {
  try {
    return app.getVersion() || PACKAGE_VERSION;
  } catch {
    return PACKAGE_VERSION;
  }
}

export function formatAppVersionLabel(version = getAppVersion()): string {
  return `v${version.replace(/\.0$/, '')}`;
}
