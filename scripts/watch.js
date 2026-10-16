#!/usr/bin/env node
/**
 * Taktik Desktop — Daily Update Watch
 *
 * Every day this script:
 *  1. Health-checks https://taktikmarketing.space (the desktop app's backend).
 *  2. Detects changes in the content bundled into the Offline Toolkit
 *     (playbook packs, hook-bank formulas in the Taktik plugin source).
 *  3. If content changed: regenerates the offline data, bumps the patch
 *     version, rebuilds all installers, smoke-tests them.
 *  4. If a GitHub token is available (GH_TOKEN): publishes a GitHub Release
 *     so the app's auto-updater notifies users automatically.
 *  5. Writes a JSON report for the cron to decide on user notification.
 *
 * Usage: node scripts/watch.js [--force]
 */
'use strict';
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const APP_DIR = path.join(__dirname, '..');
const HASH_FILE = path.join(APP_DIR, '.last-content-hash');
const REPORT_FILE = path.join(APP_DIR, '.last-watch-report.json');
const SITE_URL = 'https://taktikmarketing.space';
const CONTENT_SOURCES = [
  '/home/hatch/workspace/taktik-ai-studio/includes/playbooks/class-tas-playbook-packs.php',
  '/home/hatch/workspace/taktik-ai-studio/includes/hook-bank/class-tas-hook-bank-prompts.php',
];

const report = { date: new Date().toISOString(), siteUp: false, siteCode: null,
  contentChanged: false, rebuilt: false, published: false, notes: [] };
const note = (m) => { report.notes.push(m); console.log('[watch] ' + m); };
const sh = (cmd, opts = {}) => execSync(cmd, { cwd: APP_DIR, stdio: 'pipe', ...opts }).toString().trim();

// 1. Site health -------------------------------------------------------------
try {
  const code = sh(`curl -s -o /dev/null -w "%{http_code}" --max-time 25 ${SITE_URL}/`);
  report.siteCode = code;
  report.siteUp = code === '200';
  note(`site health: HTTP ${code} (${report.siteUp ? 'UP' : 'DOWN'})`);
} catch (e) {
  note('site health: UNREACHABLE (' + e.message.split('\n')[0] + ')');
}

// 2. Content change detection -------------------------------------------------
const hashContent = () => {
  const h = crypto.createHash('sha256');
  for (const f of CONTENT_SOURCES) {
    if (fs.existsSync(f)) h.update(fs.readFileSync(f));
    else note('source missing: ' + f);
  }
  return h.digest('hex');
};
const currentHash = hashContent();
const lastHash = fs.existsSync(HASH_FILE) ? fs.readFileSync(HASH_FILE, 'utf8').trim() : 'none';
report.contentChanged = process.argv.includes('--force') || currentHash !== lastHash;
note(`content hash: ${currentHash.slice(0, 12)}… (last: ${lastHash.slice(0, 12)}) changed=${report.contentChanged}`);

// 3. Rebuild if changed -------------------------------------------------------
if (report.contentChanged) {
  try {
    note('regenerating offline toolkit data…');
    sh(`/usr/bin/php -r '
      define("ABSPATH", "/tmp/");
      function __($s, $d=null) { return $s; }
      require "/home/hatch/workspace/taktik-ai-studio/includes/playbooks/class-tas-playbook-packs.php";
      $packs = TAS_Playbook_Packs::all();
      $out = [];
      foreach ($packs as $p) { $out[] = ["id"=>$p["id"],"title"=>$p["title"],"description"=>$p["description"],"pain_formula"=>$p["pain_formula"],"prompts"=>array_map(function($pr){return ["id"=>$pr["id"],"title"=>$pr["title"],"template"=>$pr["template"],"tool_target"=>$pr["tool_target"]];},$p["prompts"])]; }
      file_put_contents("assets/offline-tools/playbooks-data.js", "window.TAKTIK_PLAYBOOKS = ".json_encode($out, JSON_UNESCAPED_UNICODE).";");
      echo "packs: ".count($out)."\\n";
    '`);

    note('bumping patch version…');
    const pkg = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8'));
    const [maj, min, pat] = pkg.version.split('.').map(Number);
    pkg.version = `${maj}.${min}.${pat + 1}`;
    fs.writeFileSync(path.join(APP_DIR, 'package.json'), JSON.stringify(pkg, null, 2));
    report.newVersion = pkg.version;
    note('new version: ' + pkg.version);

    note('rebuilding installers (this takes a while)…');
    sh('rm -rf dist && CSC_IDENTITY_AUTO_DISCOVERY=false WINEDEBUG=-all TMPDIR=$HOME/workspace/taktik-desktop-app/.build-tmp ' +
       './node_modules/.bin/electron-builder --win zip --x64 --mac zip --arm64 --x64 --linux appimage deb --x64',
       { stdio: 'pipe', timeout: 3600000 });

    note('smoke-testing…');
    const smoke = sh('timeout 90 xvfb-run -a ./node_modules/.bin/electron --no-sandbox --ignore-certificate-errors . --smoke-test --smoke-toolkit 2>&1 | grep -a SMOKE | head -4');
    if (!smoke.includes('SMOKE OK')) throw new Error('smoke test failed: ' + smoke);
    note('smoke test passed');
    const files = fs.readdirSync(path.join(APP_DIR, 'dist')).filter(f => /\.(zip|AppImage|deb)$/.test(f));
    note('installers: ' + files.join(', '));
    report.rebuilt = true;
    fs.writeFileSync(HASH_FILE, currentHash);

    // 4. Publish to GitHub if token available --------------------------------
    const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
    if (token) {
      note('publishing GitHub release…');
      const tag = 'v' + pkg.version;
      const notes = fs.existsSync(path.join(APP_DIR, `RELEASE_NOTES_v${pkg.version}.md`))
        ? `--notes-file RELEASE_NOTES_v${pkg.version}.md` : '--notes "Offline content sync"';
      sh(`GH_TOKEN=${token} gh release create ${tag} --repo taktik-ai-studio-desktop --title "Taktik AI Studio ${pkg.version}" ${notes} ` +
         files.map(f => `dist/${f}`).join(' '), { env: { ...process.env, GH_TOKEN: token } });
      report.published = true;
      note(`published ${tag} to GitHub Releases — users will be auto-notified by the app`);
    } else {
      note('NO GitHub token configured — release NOT published. Installers ready in dist/ for manual publish.');
    }
  } catch (e) {
    note('REBUILD FAILED: ' + e.message.split('\n').slice(0, 3).join(' | '));
    report.error = e.message.split('\n')[0];
  }
}

fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2));
console.log('[watch] done: ' + JSON.stringify({ siteUp: report.siteUp, contentChanged: report.contentChanged, rebuilt: report.rebuilt, published: report.published }));
process.exit(report.error ? 1 : 0);
