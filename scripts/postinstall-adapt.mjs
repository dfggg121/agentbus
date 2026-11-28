// One-shot auto-adapt for untested MCP clients after a global install.
// Local installs stay inert; set AGENTBUS_AUTO_ADAPT=1 to force a run, or
// AGENTBUS_NO_AUTO_ADAPT=1 to opt out. Failures never break npm install.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { adaptPresets } from '../src/presets.js';

const globalInstall = process.env.npm_config_global === 'true' || process.env.npm_config_global === '1';
const forced = process.env.AGENTBUS_AUTO_ADAPT === '1';
const disabled = process.env.AGENTBUS_NO_AUTO_ADAPT === '1';
if ((!globalInstall && !forced) || disabled) process.exit(0);

const home = os.homedir();
const logFile = path.join(home, '.agentbus', 'auto-adapt.json');
try {
  const report = await adaptPresets({ home, role: 'worker', probe: true });
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.writeFileSync(logFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  } catch {}
  if (process.env.AGENTBUS_AUTO_ADAPT_VERBOSE === '1') {
    const summary = report.summary || {};
    console.error(`[agentbus] auto-adapt: ok=${report.ok} detected=${summary.detected || 0} ok=${summary.ok || 0} failed=${summary.failed || 0} manual=${summary.manual || 0}`);
  }
} catch (e) {
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.writeFileSync(`${logFile}.error`, `${String(e.message || e)}\n`, 'utf8');
  } catch {}
  if (process.env.AGENTBUS_AUTO_ADAPT_VERBOSE === '1') {
    console.error(`[agentbus] auto-adapt failed: ${String(e.message || e)}`);
  }
}
process.exit(0);
