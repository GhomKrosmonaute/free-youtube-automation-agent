#!/usr/bin/env node
// One command, no dashboard: starts the agent, switches continuous mode on, and reports what it is
// doing until Ctrl-C (which pauses new runs and stops the server cleanly). A line is printed when the
// activity or the counters change, plus a reminder every 10 min during production (hourly when idle).
// Every video waits for a human approval in the dashboard before publication; --autonome publishes
// as soon as the automatic checks pass.
require('dotenv').config();
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
const readline = require('readline');
const { Database } = require('../database/db');

const PORT = process.env.PORT || 3456;
const KEY = process.env.API_KEY || '';
const root = path.join(__dirname, '..');
const args = process.argv.slice(2);
const flag = name => args.includes(`--${name}`);
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i !== -1 && args[i + 1] ? args[i + 1] : fallback; };

function api(pathname, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: pathname, method, headers: { 'x-api-key': KEY, 'Content-Type': 'application/json' } }, res => {
      let data = ''; res.on('data', c => { data += c; }); res.on('end', () => { try { resolve(JSON.parse(data)); } catch (_e) { resolve(null); } });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

const stamp = () => new Date().toLocaleTimeString('fr-FR', { hour12: false });
const log = line => process.stdout.write(`${stamp()}  ${line}\n`);

async function setSettings(db, values) {
  for (const [k, v] of Object.entries(values)) await db.setSetting(k, String(v));
}

const JOB_STAGES = {
  strategy: 'stratégie', script: 'script', expert_review: "besoin d'un expert ?", thumbnail: 'miniature', seo: 'SEO',
  production: 'voix, images et montage', fact_check: 'vérification des faits', quality_review: 'contrôle qualité'
};
const RUN_STAGES = { queued: 'démarrage', researching: 'recherche des sujets', planning: 'planification', resuming: 'reprise', resuming_plan: 'reprise' };
const RUN_OUTCOMES = {
  completed: 'terminé', completed_with_issues: 'terminé avec des échecs', waiting_review: 'en attente de validation',
  failed: 'échoué', cancelled: 'annulé', interrupted: 'interrompu'
};
const ACTIVE_RUN = ['queued', 'running', 'cancelling'];
const REMINDER_MIN = { active: 10, idle: 60 };
const CHECK_MS = 10 * 60e3; // continuous mode is checked on every 10-minute cron tick (schedules/daily-automation.js)
const DAY_MS = 86400e3;

const label = (names, key) => names[key] || String(key).replace(/_/g, ' ');
// SQLite's datetime('now') is UTC without a zone marker; ISO strings parse as they are.
const toDate = s => new Date(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(s || '') ? `${s.replace(' ', 'T')}Z` : s);
const when = ms => new Date(ms).toDateString() === new Date().toDateString()
  ? new Date(ms).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
  : new Date(ms).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const nextCheck = ms => Math.ceil((ms + 1) / CHECK_MS) * CHECK_MS;
function duration(ms) {
  const min = Math.round(ms / 60e3);
  if (min < 1) return "moins d'une minute";
  if (min < 60) return `${min} min`;
  if (min < 48 * 60) return `${Math.floor(min / 60)} h${min % 60 ? ` ${String(min % 60).padStart(2, '0')}` : ''}`;
  return `${Math.round(min / 1440)} j`;
}

// What the agent is doing right now. `key` changes with the activity (new stage, new video, run over)
// and resets the stage timer; `counters` changing alone just reprints the line.
async function snapshot() {
  const j = await api('/api/dashboard').catch(() => null);
  if (!j) return { key: 'down', text: 'serveur injoignable', counters: '' };
  const now = Date.now();
  const settings = j.settings || {};
  const runs = j.operatorRuns || [];
  const run = runs.find(r => ACTIVE_RUN.includes(r.status));
  const job = (j.jobs || []).find(x => x.status === 'running');
  const review = (j.pipeline || []).filter(p => ['needs_review', 'needs_attention'].includes(p.review_status)).length;
  const expert = (j.jobs || []).filter(x => x.status === 'waiting_expert').length;
  const counters = [
    `publiés 24h: ${j.stats?.publishedLast24h ?? '?'}`,
    `en file: ${(j.schedule || []).filter(s => s.status === 'scheduled').length}`,
    review ? `en attente humaine: ${review}` : null,
    expert ? `script en attente d'expert: ${expert} (npm run expert)` : null
  ].filter(Boolean).join(' | ');

  if (run || job) {
    const [, index, total] = (run?.stage || '').match(/^producing_(\d+)_of_(\d+)$/) || [];
    const video = Number(total) > 1 ? `vidéo ${index}/${total}` : 'vidéo';
    const step = job ? (job.stage ? label(JOB_STAGES, job.stage) : 'démarrage') : index ? 'préparation' : null;
    const text = step ? `${video} : ${step}` : label(RUN_STAGES, run.stage);
    return { key: `${run?.id}:${job?.id}:${step || run.stage}`, active: true, text, step: step || text, counters, run, job };
  }

  const last = runs[0];
  let text = 'en veille';
  if (last) text += ` | dernier run ${label(RUN_OUTCOMES, last.status)} il y a ${duration(now - toDate(last.completed_at || last.updated_at))}`;
  let waiting = 'continue';
  if (settings.continuous_operator !== 'true') waiting = 'off';
  else if (settings.automation_paused === 'true') waiting = 'paused';
  else {
    // Same window as DailyAutomation.startContinuousRunIfDue: the last 24 h, and only since continuous mode was switched on.
    const since = Math.max(now - DAY_MS, settings.continuous_operator_since ? toDate(settings.continuous_operator_since).getTime() : 0);
    const started = (j.jobs || [])
      .filter(x => x.source === 'autonomous_operator' && ['completed', 'running', 'queued', 'failed'].includes(x.status) && toDate(x.created_at) >= since)
      .map(x => toDate(x.created_at).getTime()).sort((a, b) => a - b);
    const perDay = Number(settings.max_daily_posts || 1);
    if (started.length >= perDay) {
      waiting = 'quota';
      text += ` | quota atteint (${started.length}/${perDay} sur 24 h), prochain run vers ${when(nextCheck(started[started.length - perDay] + DAY_MS))}`;
    } else {
      text += ` | prochain essai ${when(nextCheck(now))}`;
    }
  }
  if (waiting === 'off') text += ' | production continue désactivée';
  if (waiting === 'paused') text += ' | automatisation en pause';
  return { key: `idle:${last?.id}:${last?.status}:${waiting}`, active: false, text, counters, last };
}

function runSummary(run) {
  const s = run.summary || {};
  const took = run.completed_at ? ` en ${duration(toDate(run.completed_at) - toDate(run.created_at))}` : '';
  const detail = s.planned
    ? ` : ${s.generated}/${s.planned} vidéo(s) produite(s)${s.needsReview ? `, ${s.needsReview} à valider` : ''}${s.failed ? `, ${s.failed} en échec` : ''}`
    : run.error ? ` : ${run.error}` : '';
  return `run ${label(RUN_OUTCOMES, run.status)}${took}${detail}`;
}

let shown = null; // last snapshot printed, with when its activity started (since) and when it was printed (at)
function report(snap) {
  const now = Date.now();
  if (!shown || snap.key !== shown.key) {
    if (shown?.run && !snap.active && snap.last?.id === shown.run.id) log(runSummary(snap.last));
    if (snap.job && snap.job.id !== shown?.job?.id && snap.job.topic) {
      log(`sujet : ${snap.job.topic.length > 110 ? `${snap.job.topic.slice(0, 109)}…` : snap.job.topic}`);
    }
    const previous = shown?.active && snap.active ? ` (${shown.step} en ${duration(now - shown.since)})` : '';
    log([snap.text + previous, snap.counters].filter(Boolean).join(' | '));
    shown = { ...snap, since: now, at: now };
  } else if (snap.counters !== shown.counters) {
    log([snap.text, snap.counters].filter(Boolean).join(' | '));
    shown = { ...shown, counters: snap.counters, at: now };
  } else if (now - shown.at >= REMINDER_MIN[snap.active ? 'active' : 'idle'] * 60e3) {
    log(snap.active ? `… ${snap.text} depuis ${duration(now - shown.since)}` : `… ${snap.text}`);
    shown.at = now;
  }
}

// Server lines worth surfacing, without the logger's [Component] [LEVEL] prefix and in French where known.
function reword(line) {
  const [, level, message] = line.match(/^\[[^\]]+\] \[(\w+)\] (.*)$/) || [null, null, line];
  let m;
  if ((m = message.match(/^Continuous operator started run \S+ \((\d+)\/(\d+) today\)/))) return `nouveau run lancé (${m[1]}/${m[2]} sur 24 h)`;
  if ((m = message.match(/^Content published: (\S+)/))) return `publié : ${m[1]}`;
  if ((m = message.match(/^Auto Short scheduled for (.*): \S+ at (\S+)$/))) {
    const at = toDate(m[2]).getTime();
    return `short programmé ${Number.isNaN(at) ? m[2] : when(at)} : ${m[1]}`;
  }
  if (level === 'ERROR') return `erreur : ${message}`;
  if (level === 'WARN') return `attention : ${message}`;
  return message;
}

// Surface the server lines that matter. The logger prints an error's stack on stderr next to its
// [ERROR] line on stdout; the two pipes can deliver in either order, so pair them within 2 s and keep
// the stack's first line, which carries the reason.
function relayServerLogs(streams) {
  const important = /ERROR|WARN.*(fact-check|Studio|Illustration)|Continuous operator started|Content published|Auto Short scheduled|Operator run .* (failed|completed)|needs attention|ready for/;
  const ansi = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');
  const reason = line => log(`  ↳ ${line}`);
  let errorAt = 0;
  let pending = null;
  for (const stream of streams) {
    readline.createInterface({ input: stream }).on('line', raw => {
      const line = raw.replace(ansi, '').replace(/^\d\d:\d\d:\d\d /, '');
      if (important.test(line)) {
        log(reword(line));
        if (!/\[ERROR\]/.test(line)) return;
        if (pending && Date.now() - pending.at < 2000) { reason(pending.line); pending = null; } else errorAt = Date.now();
      } else if (/^\w*Error: /.test(line)) {
        if (Date.now() - errorAt < 2000) { reason(line); errorAt = 0; } else pending = { line, at: Date.now() };
      }
    });
  }
}

(async () => {
  if (flag('status')) { const snap = await snapshot(); console.log([snap.text, snap.counters].filter(Boolean).join(' | ')); process.exit(0); }
  const db = new Database(); await db.initialize();
  const perDay = Number(opt('per-day', process.env.MAX_DAILY_POSTS || 2));
  const autonomous = flag('autonome');
  await setSettings(db, {
    continuous_operator: flag('no-produce') ? 'false' : 'true',
    continuous_operator_since: new Date().toISOString().replace('T', ' ').slice(0, 19),
    max_daily_posts: perDay, auto_shorts: flag('no-shorts') ? 'false' : 'true',
    approval_required: autonomous ? 'false' : 'true', auto_publish_enabled: 'true', automation_paused: 'false'
  });
  const strategy = await db.getChannelStrategy();
  if (strategy && strategy.status !== 'active') await db.saveChannelStrategy({ ...strategy, status: 'active' });
  if (db.close) await db.close();

  const server = spawn('node', ['index.js'], { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  relayServerLogs([server.stdout, server.stderr]);
  let stopping = false;
  server.on('exit', code => {
    log(`serveur arrêté (code ${code})`);
    // Ctrl-C signals the server too, so it can exit first: stop() still has to record the pause before leaving.
    if (!stopping) process.exit(code || 0);
  });

  log(`${process.env.CHANNEL_NAME || 'La chaîne'} : production continue, ${perDay} vidéo(s)/24h${flag('no-shorts') ? ', sans shorts' : ', shorts automatiques'}. Ctrl-C pour arrêter.`);
  log(autonomous
    ? 'Publication sans validation humaine (--autonome).'
    : `Validation humaine avant publication : http://localhost:${PORT} (npm run auto -- --autonome pour s'en passer).`);
  const wait = ms => new Promise(r => setTimeout(r, ms));
  // ECONNREFUSED until index.js has finished initialize() and called listen(); keep polling.
  for (let i = 0; i < 60; i++) { await wait(1000); if (await api('/health').catch(() => null)) break; }
  report(await snapshot());
  const ticker = setInterval(async () => { try { report(await snapshot()); } catch (_e) { /* next tick */ } }, Number(opt('every', 60)) * 1000);

  const stop = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(ticker);
    log('arrêt demandé : pause des nouveaux runs, arrêt du serveur…');
    try { const db2 = new Database(); await db2.initialize(); await db2.setSetting('continuous_operator', 'false'); if (db2.close) await db2.close(); } catch (_e) { /* ignore */ }
    if (server.exitCode !== null || server.signalCode !== null) process.exit(0);
    server.on('exit', () => process.exit(0));
    server.kill('SIGTERM');
    setTimeout(() => process.exit(0), 3000);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
})().catch(error => { console.error(error.message); process.exit(1); });
