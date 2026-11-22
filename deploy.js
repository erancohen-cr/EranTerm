// Deployment engine. Transport-agnostic: `io.connect(target)` returns a session with
// exec(script, onData) -> {code}, upload(localPath, remoteDir), close(). main.js wires it to SSH;
// the test wires it to the local shell.
const net = require('node:net');
const path = require('node:path');
const { shq } = require('./util');

const STAGES = ['pre', 'files', 'deploy', 'post'];
const LABEL = { pre: 'Pre-deploy', files: 'Files', deploy: 'Deploy', post: 'Post-deploy' };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const validCheck = c =>
  (c.type === 'port' && Number(c.port) > 0) ||
  (c.type === 'log' && c.file && c.pattern) ||
  (c.type === 'exit' && String(c.command || '').trim());

function checkLabel(c) {
  if (c.type === 'port') return `TCP ${c.host || '<server>'}:${c.port} responds`;
  if (c.type === 'log') return `${c.file} ${c.expect === 'absent' ? 'does not contain' : 'contains'} /${c.pattern}/`;
  return `\`${String(c.command).split('\n')[0]}\` exits ${Number(c.expectCode) || 0}`;
}

const tcpOpen = (host, port, ms = 3000) => new Promise(resolve => {
  const sock = net.connect({ host, port: Number(port) });
  const done = ok => { sock.destroy(); resolve(ok); };
  sock.setTimeout(ms, () => done(false));
  sock.once('connect', () => done(true));
  sock.once('error', () => done(false));
});

// Retries every 2s until it passes or `timeout` seconds pass (0 = one attempt).
async function runCheck(c, target, sess, signal) {
  const deadline = Date.now() + (Number(c.timeout) || 0) * 1000;
  for (;;) {
    let ok, detail;
    if (c.type === 'port') {
      const host = c.host || target.host;
      ok = await tcpOpen(host, c.port);
      detail = `${host}:${c.port} ${ok ? 'is open' : 'is not responding'}`;
    } else if (c.type === 'log') {
      const n = Math.max(1, parseInt(c.lines, 10) || 200);
      let out = '';
      const r = await sess.exec(`tail -n ${n} -- ${shq(c.file)} | grep -E -m 1 -- ${shq(c.pattern)}`, d => (out += d));
      const found = r.code === 0;
      ok = c.expect === 'absent' ? !found : found;
      detail = found ? `matched: ${out.trim().slice(0, 200)}` : `no match in last ${n} lines`;
    } else {
      const r = await sess.exec(c.command);
      ok = r.code === (Number(c.expectCode) || 0);
      detail = `exit code ${r.code}`;
    }
    if (ok || Date.now() >= deadline || signal?.aborted) return { ok, detail };
    await sleep(2000);
  }
}

async function runTarget(dep, target, io, signal) {
  const emit = ev => io.emit({ target: target.id, ...ev });
  const log = (text, level = 'info') => emit({ kind: 'log', text, level });
  const stage = (name, state) => emit({ kind: 'stage', stage: name, state });
  let sess, warnings = 0, status;
  emit({ kind: 'status', status: 'running' });
  try {
    log(`Connecting to ${target.name} (${target.host})…`);
    sess = await io.connect(target);
    for (const st of STAGES) {
      if (signal?.aborted) throw new Error('Cancelled');
      if (st === 'files') {
        if (!dep.files?.length) continue;
        stage(st, 'running');
        for (const f of dep.files) {
          if (signal?.aborted) throw new Error('Cancelled');
          log(`↑ ${path.basename(f.local)} → ${f.remoteDir || '~'}`, 'cmd');
          await sess.upload(f.local, f.remoteDir);
        }
        stage(st, 'ok');
        continue;
      }
      const cmds = (dep.stages?.[st]?.commands || []).filter(c => String(c).trim());
      const checks = (dep.stages?.[st]?.checks || []).filter(validCheck);
      if (!cmds.length && !checks.length) continue;
      stage(st, 'running');
      let stageWarn = false;
      for (const cmd of cmds) {
        if (signal?.aborted) throw new Error('Cancelled');
        const lines = cmd.trim().split('\n');
        log(`$ ${lines[0]}${lines.length > 1 ? ` … (+${lines.length - 1} lines)` : ''}`, 'cmd');
        const r = await sess.exec(cmd, d => log(d, 'out'));
        if (r.code !== 0) { stage(st, 'failed'); throw new Error(`${LABEL[st]}: command exited with code ${r.code}`); }
      }
      for (const c of checks) {
        log(`? ${checkLabel(c)}${Number(c.timeout) ? ` (wait up to ${c.timeout}s)` : ''}`, 'check');
        const r = await runCheck(c, target, sess, signal);
        if (r.ok) log(`✓ ${r.detail}`, 'ok');
        else if (c.onFail === 'alert') { warnings++; stageWarn = true; log(`⚠ ${r.detail} — alert only, continuing`, 'warn'); }
        else { stage(st, 'failed'); throw new Error(`${LABEL[st]} verification failed: ${checkLabel(c)} (${r.detail})`); }
      }
      stage(st, stageWarn ? 'warn' : 'ok');
    }
    status = warnings ? 'warning' : 'success';
    log(warnings ? `Done with ${warnings} alert${warnings > 1 ? 's' : ''}.` : 'Done.', warnings ? 'warn' : 'ok');
  } catch (e) {
    status = signal?.aborted ? 'cancelled' : 'failed';
    log(status === 'cancelled' ? 'Cancelled.' : e.message, 'error');
  } finally {
    try { sess?.close(); } catch { /* already closed */ }
  }
  emit({ kind: 'status', status, warnings });
  return status;
}

// Sequential runs stop at the first failed server (rolling deploy); parallel runs all.
async function runDeployment(dep, targets, io, signal) {
  if (dep.parallel) return Promise.all(targets.map(t => runTarget(dep, t, io, signal)));
  const results = [];
  for (const t of targets) {
    if (signal?.aborted || results.some(r => r === 'failed' || r === 'cancelled')) {
      io.emit({ target: t.id, kind: 'status', status: 'skipped' });
      results.push('skipped');
      continue;
    }
    results.push(await runTarget(dep, t, io, signal));
  }
  return results;
}

module.exports = { runDeployment, runCheck, checkLabel, tcpOpen, STAGES };
