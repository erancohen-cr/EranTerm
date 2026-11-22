/* global api, el, iconBtn, toast, cleanErr, servers, notify */
// Deployments panel: edit saved deployments, run them on many servers, watch per-server progress.
// Runs happen in main (deploy.js); this file only edits definitions and renders events.

const deployRunHandlers = new Map(); // runId -> event handler
api.deploy.onEvent((runId, ev) => deployRunHandlers.get(runId)?.(ev));

const D_STAGES = [
  ['pre', 'Pre-deploy', 'Runs first: backups, stopping services, sanity checks.'],
  ['files', 'Files', 'Copied to every target server. Folders keep their structure.'],
  ['deploy', 'Deploy', 'Install and configure.'],
  ['post', 'Post-deploy', 'Restart services, smoke tests, cleanup.'],
];
const D_CHECKS = { log: 'Log check', port: 'TCP port', exit: 'Script exit code' };
const D_STATUS = { pending: 'Pending', running: 'Running', success: 'Success', warning: 'Success with alerts', failed: 'Failed', cancelled: 'Cancelled', skipped: 'Skipped' };

const newCheck = (type, onFail = 'stop') => ({
  type, onFail, timeout: type === 'exit' ? 0 : 30,
  ...(type === 'log' ? { file: '', pattern: '', expect: 'present', lines: 200 }
    : type === 'port' ? { host: '', port: '' } : { command: '', expectCode: 0 }),
});
const blankDeployment = () => ({
  id: null, name: 'New deployment', targets: [], parallel: false, files: [],
  stages: { pre: { commands: [], checks: [] }, deploy: { commands: [], checks: [] }, post: { commands: [], checks: [] } },
});

// Stages that will actually run for a definition (mirrors deploy.js: empty stages are skipped).
const dStagesOf = d => D_STAGES.filter(([k]) => k === 'files' ? d.files?.length
  : (d.stages?.[k]?.commands || []).some(c => String(c).trim()) || (d.stages?.[k]?.checks || []).some(c =>
    (c.type === 'port' && Number(c.port) > 0) || (c.type === 'log' && c.file && c.pattern) || (c.type === 'exit' && String(c.command || '').trim())));
const D_ICON = { ok: '✓', warn: '!', failed: '✕', skipped: '–' };
const D_FINAL = ['success', 'warning', 'failed', 'cancelled', 'skipped'];

function initDeployments(panel) {
  let list = [], cur = null, dirty = false, lib = [];
  let shown = null; // run whose status view is on screen
  const tFilter = { group: null, q: '' }; // target-server filter (view only, not saved)
  const runs = new Map(); // deploymentId -> last run (kept so its status can be reopened)
  const listEl = panel.querySelector('.dl');
  const ed = panel.querySelector('.deditor');

  // ---------- list ----------
  async function load(selectId) {
    try { [list, lib] = await Promise.all([api.deploy.list(), api.scripts.list()]); } catch (e) { toast(cleanErr(e), true); }
    const pick = list.find(d => d.id === selectId);
    if (pick) select(pick, true);
    else if (!cur && !shown) renderEmpty();
    renderList();
  }
  function renderList() {
    panel.querySelector('.dcount').textContent = list.length;
    listEl.replaceChildren(...list.map(d => {
      const r = runs.get(d.id);
      const act = (text, title, fn, cls = '') => el('button', { className: 'dact ' + cls, textContent: text, title,
        onclick: e => { e.stopPropagation(); fn(); } });
      return el('li', {
        className: (d.id === (shown ? shown.dep.id : cur?.id) ? 'active' : '') + (r?.running ? ' running' : ''),
        onclick: () => (r?.running ? showStatus(r) : select(d)),
      }, el('b', { textContent: d.name }),
      el('small', { textContent: `${d.targets.length} server${d.targets.length === 1 ? '' : 's'} · ${d.files.length} file${d.files.length === 1 ? '' : 's'}` }),
      el('div', { className: 'dacts' },
        act('✎ Edit', 'Edit configuration', () => select(d)),
        r?.running ? act('■ Stop', 'Stop this run', () => api.deploy.cancel(r.id), 'stop')
          : act('▶ Run', 'Run deployment', () => runFromList(d), 'run'),
        r ? act('◉', 'Status of the last run', () => showStatus(r)) : null,
        el('span', { className: 'grow' }),
        act('🗑', 'Delete deployment', () => remove(d), 'del')));
    }));
  }
  // Leaving the editor: ask before throwing away edits.
  function leave() {
    if (dirty && !confirm('Discard unsaved changes?')) return false;
    dirty = false;
    return true;
  }
  function select(d, force = false) {
    if (!force && !leave()) return;
    cur = structuredClone(d);
    dirty = false;
    shown = null;
    renderEditor();
    renderList();
  }
  function renderEmpty() {
    cur = null; shown = null;
    ed.className = 'deditor';
    ed.replaceChildren(el('div', { className: 'empty' },
      el('p', { textContent: 'Push files to one or more servers and run commands around them, with checks between stages.' }),
      el('button', { className: 'primary', textContent: '＋ New deployment', onclick: () => select(blankDeployment()) })));
    renderList();
  }
  panel.querySelector('.dnew').onclick = () => select(blankDeployment());

  // ---------- editor helpers ----------
  const touch = () => { dirty = true; ed.querySelector('.dsave')?.classList.add('dirty'); };
  const rerender = () => { touch(); renderEditor(); };
  function inp(obj, key, attrs = {}, tag = 'input') {
    const e = el(tag, attrs);
    e.value = obj[key] ?? '';
    e.oninput = () => { obj[key] = e.type === 'number' ? (e.value === '' ? '' : Number(e.value)) : e.value; touch(); };
    return e;
  }
  function sel(obj, key, options, after) {
    const e = el('select', {}, ...Object.entries(options).map(([value, textContent]) => el('option', { value, textContent })));
    e.value = obj[key];
    e.onchange = () => { obj[key] = e.value; touch(); after?.(); };
    return e;
  }
  const hint = text => el('small', { className: 'muted', textContent: text });

  // ---------- editor ----------
  function renderEditor() {
    const d = cur;
    const r = d.id && runs.get(d.id);
    ed.className = 'deditor';
    const head = el('div', { className: 'dhead' },
      inp(d, 'name', { className: 'dname', placeholder: 'Deployment name' }),
      el('span', { className: 'grow' }),
      el('button', { className: 'dsave' + (dirty ? ' dirty' : ''), textContent: 'Save', onclick: save }),
      d.id ? el('button', { textContent: 'Delete', onclick: () => remove(d) }) : null,
      r ? el('button', { textContent: r.running ? '◉ Running…' : '◉ Last run', onclick: () => showStatus(r) }) : null,
      r?.running ? null : el('button', { className: 'primary', textContent: '🚀 Run deployment', onclick: start }));

    const ssh = servers.filter(x => x.type !== 'rdp');
    // Filters only narrow what is shown; selection is kept. Applied by hiding chips so typing keeps focus.
    const shown$ = x => (!tFilter.group || (x.group || '') === tFilter.group) &&
      (!tFilter.q || [x.name, x.host, x.group || '', x.details || '', ...(x.tags || [])].some(v => v.toLowerCase().includes(tFilter.q)));
    const chips = ssh.map(x => {
      const cb = el('input', { type: 'checkbox', checked: d.targets.includes(x.id) });
      cb.onchange = () => {
        d.targets = cb.checked ? [...d.targets, x.id] : d.targets.filter(id => id !== x.id);
        rerender();
      };
      const chip = el('label', { className: 'dchip' + (cb.checked ? ' on' : ''), hidden: !shown$(x) }, cb,
        el('b', { textContent: x.name }), el('small', { className: 'mono', textContent: x.host }));
      chip.srv = x;
      return chip;
    });
    const applyFilter = () => chips.forEach(c => (c.hidden = !shown$(c.srv)));
    const groups = [...new Set(ssh.map(x => x.group || ''))].sort((a, b) => a.localeCompare(b));
    const gsel = el('select', {}, el('option', { value: '\u0000', textContent: 'All groups' }),
      ...groups.map(g => el('option', { value: g, textContent: g || 'Ungrouped' })));
    gsel.value = tFilter.group ?? '\u0000';
    gsel.onchange = () => { tFilter.group = gsel.value === '\u0000' ? null : gsel.value; applyFilter(); };
    const q = el('input', { type: 'search', placeholder: 'Filter: name, host, tag…', value: tFilter.q });
    q.oninput = () => { tFilter.q = q.value.trim().toLowerCase(); applyFilter(); };
    const pickShown = on => {
      const ids = chips.filter(c => !c.hidden).map(c => c.srv.id);
      d.targets = on ? [...new Set([...d.targets, ...ids])] : d.targets.filter(id => !ids.includes(id));
      rerender();
    };
    const targets = el('section', { className: 'dcard' },
      el('header', {}, el('b', { textContent: 'Target servers' }), hint(`${d.targets.length} selected`)),
      el('div', { className: 'dfilter' }, gsel, q,
        el('button', { textContent: 'Select shown', onclick: () => pickShown(true) }),
        el('button', { textContent: 'Clear shown', onclick: () => pickShown(false) })),
      el('div', { className: 'dchips' }, ...chips),
      el('label', { className: 'chk' }, (() => {
        const cb = el('input', { type: 'checkbox', checked: d.parallel });
        cb.onchange = () => { d.parallel = cb.checked; touch(); };
        return cb;
      })(), ' Run all servers in parallel'),
      hint('Sequential (default) deploys one server at a time and stops at the first failed server.'));

    ed.replaceChildren(head, targets, ...D_STAGES.map(([key, title, text], i) =>
      el('section', { className: 'dcard' },
        el('header', {}, el('span', { className: 'dnum', textContent: i + 1 }), el('b', { textContent: title }), hint(`${text} Optional.`)),
        key === 'files' ? filesBody(d) : stageBody(d.stages[key]))));
  }

  function filesBody(d) {
    const add = paths => {
      if (!paths?.length) return;
      const dir = d.files.at(-1)?.remoteDir || '/tmp';
      d.files.push(...paths.map(local => ({ local, remoteDir: dir })));
      rerender();
    };
    const drop = el('div', { className: 'ddrop' },
      el('span', { textContent: 'Drop files or folders here, or ' }),
      el('button', { textContent: '＋ Add files / folders', onclick: async () => add(await api.deploy.pickFiles()) }));
    drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
    drop.ondragleave = () => drop.classList.remove('over');
    drop.ondrop = e => {
      e.preventDefault();
      drop.classList.remove('over');
      add([...e.dataTransfer.files].map(f => api.pathForFile(f)).filter(Boolean));
    };
    return el('div', {},
      ...d.files.map((f, i) => el('div', { className: 'drow' },
        el('span', { className: 'mono dlocal', textContent: f.local, title: f.local }),
        el('span', { className: 'muted', textContent: '→' }),
        inp(f, 'remoteDir', { className: 'mono', placeholder: 'remote folder, e.g. /opt/app or ~/app' }),
        iconBtn('×', 'Remove', () => { d.files.splice(i, 1); rerender(); }))),
      drop);
  }

  function stageBody(st) {
    const lib$ = el('select', { className: 'dlib' },
      el('option', { value: '', textContent: '＋ From script library…' }),
      ...lib.map(x => el('option', { value: x.id, textContent: x.name })));
    lib$.onchange = () => {
      const x = lib.find(y => y.id === lib$.value);
      if (x) { st.commands.push(x.command); rerender(); }
    };
    const addCheck = el('select', { className: 'dlib' },
      el('option', { value: '', textContent: '＋ Verification…' }),
      ...Object.entries(D_CHECKS).map(([value, textContent]) => el('option', { value, textContent })));
    addCheck.onchange = () => { if (addCheck.value) { st.checks.push(newCheck(addCheck.value)); rerender(); } };

    return el('div', { className: 'dstage' },
      el('h6', { textContent: 'Commands' }),
      ...st.commands.map((c, i) => {
        const t = el('textarea', { className: 'mono', spellcheck: false, rows: Math.min(10, Math.max(1, c.split('\n').length)), placeholder: 'command, or a multi-line script (#!/bin/bash supported)' });
        t.value = c;
        t.oninput = () => { st.commands[i] = t.value; t.rows = Math.min(10, Math.max(1, t.value.split('\n').length)); touch(); };
        return el('div', { className: 'drow' }, el('span', { className: 'dstep', textContent: `${i + 1}.` }), t,
          iconBtn('×', 'Remove', () => { st.commands.splice(i, 1); rerender(); }));
      }),
      el('div', { className: 'dadd' },
        el('button', { textContent: '＋ Command', onclick: () => { st.commands.push(''); rerender(); } }), lib$),
      el('h6', { textContent: 'Verifications' }),
      ...st.checks.map((c, i) => checkRow(st, c, i)),
      el('div', { className: 'dadd' }, addCheck));
  }

  function checkRow(st, c, i) {
    const type = sel(c, 'type', D_CHECKS, () => { st.checks[i] = newCheck(c.type, c.onFail); rerender(); });
    let fields;
    if (c.type === 'log') {
      fields = [inp(c, 'file', { className: 'mono w2', placeholder: '/var/log/app.log' }),
        sel(c, 'expect', { present: 'contains', absent: 'does not contain' }),
        inp(c, 'pattern', { className: 'mono w2', placeholder: 'regex, e.g. Started|listening on' }),
        el('span', { className: 'muted', textContent: 'in last' }),
        inp(c, 'lines', { type: 'number', min: 1, className: 'num' }),
        el('span', { className: 'muted', textContent: 'lines' })];
    } else if (c.type === 'port') {
      fields = [inp(c, 'host', { className: 'mono w2', placeholder: 'host (default: the target server)' }),
        inp(c, 'port', { type: 'number', min: 1, max: 65535, className: 'num', placeholder: 'port' }),
        el('span', { className: 'muted', textContent: 'responds (checked from this Mac)' })];
    } else {
      fields = [inp(c, 'command', { className: 'mono w3', placeholder: 'e.g. systemctl is-active nginx' }),
        el('span', { className: 'muted', textContent: 'exits' }),
        inp(c, 'expectCode', { type: 'number', className: 'num' })];
    }
    return el('div', { className: 'drow dcheck' }, type, ...fields,
      el('span', { className: 'muted', textContent: 'wait up to' }),
      inp(c, 'timeout', { type: 'number', min: 0, className: 'num', title: 'Retry every 2 s for up to this many seconds (0 = check once)' }),
      el('span', { className: 'muted', textContent: 's' }),
      sel(c, 'onFail', { stop: 'If it fails: stop', alert: 'If it fails: alert only' }),
      iconBtn('×', 'Remove', () => { st.checks.splice(i, 1); rerender(); }));
  }

  // ---------- save / delete ----------
  async function save() {
    try {
      const saved = await api.deploy.save(cur);
      cur.id = saved.id;
      dirty = false;
      await load(saved.id);
      return true;
    } catch (e) { toast(cleanErr(e), true); return false; }
  }
  async function remove(d) {
    if (!confirm(`Delete deployment "${d.name}"?`)) return;
    if (d.id) await api.deploy.delete(d.id);
    runs.delete(d.id);
    if (cur?.id === d.id || shown?.dep.id === d.id) { dirty = false; renderEmpty(); }
    load();
  }

  // ---------- run ----------
  async function start() { // from the editor: save first so the run matches what is on screen
    if (!cur.targets.length) return toast('Pick at least one target server.', true);
    if (await save()) runDeployment(cur);
  }
  async function runFromList(d) {
    if (dirty && cur?.id === d.id) { if (!(await save())) return; d = cur; } else if (!leave()) return;
    if (!d.targets.length) { select(d, true); return toast('Pick at least one target server.', true); }
    runDeployment(d);
  }
  async function runDeployment(d) {
    let r;
    try { r = await api.deploy.run(d); } catch (e) { return toast(cleanErr(e), true); }
    const run = { id: r.runId, dep: structuredClone(d), running: true, started: Date.now(), targets: new Map() };
    runs.set(d.id, run);
    buildStatus(run, r.targets);
    deployRunHandlers.set(r.runId, ev => onEvent(run, ev));
    tick();
    showStatus(run);
  }
  function showStatus(run) {
    if (shown !== run && !shown && !leave()) return;
    shown = run; cur = null;
    ed.className = 'deditor dstatus';
    ed.replaceChildren(run.view);
    run.con.scrollTop = run.con.scrollHeight;
    renderList();
  }

  // ---------- status view ----------
  const fmtDur = ms => { const s = Math.round(ms / 1000); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`; };
  function buildStatus(run, targets) {
    const stages = dStagesOf(run.dep);
    const multi = targets.length > 1;
    const stepDefs = [['connect', 'Connect'], ...stages.map(([k, t]) => [k, t]), ['done', 'Done']];
    run.bar = el('div', { className: 'dprog-fill' });
    run.pct = el('b', { className: 'dprog-pct', textContent: '0%' });
    run.state = el('span', { className: 'dbadge running', textContent: 'Running' });
    run.time = el('small', { className: 'muted' });
    run.stopBtn = el('button', { className: 'danger-btn', textContent: '■ Stop', onclick: () => api.deploy.cancel(run.id) });
    run.againBtn = el('button', { className: 'primary', textContent: '↻ Run again', hidden: true, onclick: () => runFromList(list.find(x => x.id === run.dep.id) || run.dep) });
    run.con = el('pre', { className: 'dcon mono' });
    run.multi = multi;

    const rows = targets.map(t => {
      const steps = Object.fromEntries(stepDefs.map(([k, title], i) => {
        const dot = el('span', { className: 'dsdot', textContent: i + 1 });
        const node = el('div', { className: 'dstep2 pending' }, dot, el('small', { textContent: title }));
        return [k, { node, dot, num: i + 1, state: 'pending' }];
      }));
      const badge = el('span', { className: 'dbadge pending', textContent: D_STATUS.pending });
      run.targets.set(t.id, { name: t.name, steps, badge, status: 'pending', bol: true });
      const track = [];
      Object.values(steps).forEach((st, i) => { if (i) track.push(el('span', { className: 'dsline' })); track.push(st.node); });
      return el('div', { className: 'dtrack' },
        el('div', { className: 'dtname' }, el('b', { textContent: t.name }), el('small', { className: 'mono muted', textContent: t.host }), badge),
        el('div', { className: 'dsteps' }, ...track));
    });

    run.view = el('div', { className: 'dsx' },
      el('section', { className: 'dsx-top' },
        el('div', { className: 'dhead' },
          el('h2', { textContent: run.dep.name }), run.state, run.time,
          el('span', { className: 'grow' }),
          el('button', { textContent: '✎ Edit', onclick: () => { const d = list.find(x => x.id === run.dep.id); if (d) select(d); } }),
          run.stopBtn, run.againBtn),
        el('div', { className: 'dprog' }, el('div', { className: 'dprog-track' }, run.bar), run.pct),
        el('div', { className: 'dtracks' }, ...rows)),
      el('section', { className: 'dsx-con' },
        el('header', {}, el('b', { textContent: 'Console' }), el('span', { className: 'grow' }),
          el('button', { className: 'dact', textContent: 'Copy', onclick: () => navigator.clipboard.writeText(run.con.textContent).then(() => toast('Console copied.')) })),
        run.con));
    paintTime(run);
  }

  function setStep(t, key, state) {
    const st = t.steps[key];
    if (!st) return;
    st.state = state;
    st.node.className = `dstep2 ${state}`;
    st.dot.textContent = D_ICON[state] || (state === 'running' ? '' : st.num);
  }
  function paintProgress(run) {
    let sum = 0;
    for (const t of run.targets.values()) {
      const all = Object.values(t.steps);
      sum += D_FINAL.includes(t.status) ? 1 : all.filter(s => s.state !== 'pending' && s.state !== 'running').length / all.length;
    }
    const pct = Math.round((sum / run.targets.size) * 100);
    run.bar.style.width = pct + '%';
    run.pct.textContent = pct + '%';
    const st = [...run.targets.values()].map(t => t.status);
    run.bar.className = 'dprog-fill' + (st.includes('failed') || st.includes('cancelled') ? ' failed' : st.includes('warning') ? ' warn' : '');
  }
  function paintTime(run) {
    run.time.textContent = `started ${new Date(run.started).toLocaleTimeString()} · ${fmtDur((run.ended || Date.now()) - run.started)}`;
  }
  let timer = null; // one clock for every running deployment
  function tick() {
    if (timer) return;
    timer = setInterval(() => {
      const live = [...runs.values()].filter(r => r.running);
      live.forEach(paintTime);
      if (!live.length) { clearInterval(timer); timer = null; }
    }, 1000);
  }

  function log(run, t, text, level) {
    const out = [];
    for (const part of text.split(/(?<=\n)/)) {
      if (run.multi && t?.bol) out.push(el('span', { className: 'l-who', textContent: `[${t.name}] ` }));
      out.push(el('span', { className: `l-${level}`, textContent: part }));
      if (t) t.bol = part.endsWith('\n');
    }
    const c = run.con;
    const atBottom = c.scrollHeight - c.scrollTop - c.clientHeight < 30;
    c.append(...out);
    if (atBottom) c.scrollTop = c.scrollHeight;
  }

  function onEvent(run, ev) {
    if (ev.kind === 'done') {
      run.running = false;
      run.ended = Date.now();
      deployRunHandlers.delete(run.id);
      const states = [...run.targets.values()].map(t => t.status);
      const failed = states.filter(x => x === 'failed').length;
      const summary = failed ? `${failed} of ${states.length} failed`
        : states.includes('cancelled') ? 'Cancelled' : states.includes('warning') ? 'Finished with alerts' : 'All servers succeeded';
      const cls = failed || states.includes('cancelled') ? 'failed' : states.includes('warning') ? 'warning' : 'success';
      run.state.className = `dbadge ${cls}`;
      run.state.textContent = summary;
      run.stopBtn.hidden = true;
      run.againBtn.hidden = false;
      paintTime(run);
      paintProgress(run);
      toast(`${run.dep.name}: ${summary}`, !!failed);
      notify(`🚀 Deployment ${run.dep.name}`, summary);
      renderList();
      if (cur?.id === run.dep.id) renderEditor();
      return;
    }
    const t = run.targets.get(ev.target);
    if (!t) { if (ev.kind === 'log') toast(ev.text, true); return; }
    if (ev.kind === 'status') {
      t.status = ev.status;
      t.badge.className = `dbadge ${ev.status}`;
      t.badge.textContent = D_STATUS[ev.status] || ev.status;
      if (ev.status === 'running') setStep(t, 'connect', 'running');
      if (D_FINAL.includes(ev.status)) {
        const bad = ev.status === 'failed' || ev.status === 'cancelled';
        for (const [k, st] of Object.entries(t.steps)) {
          if (k === 'done') setStep(t, k, ev.status === 'skipped' ? 'skipped' : bad ? 'failed' : ev.status === 'warning' ? 'warn' : 'ok');
          else if (st.state === 'running') setStep(t, k, bad ? 'failed' : 'ok');
          else if (st.state === 'pending') setStep(t, k, 'skipped');
        }
      }
    } else if (ev.kind === 'stage') {
      if (t.steps.connect.state === 'running') setStep(t, 'connect', 'ok');
      setStep(t, ev.stage, ev.state);
    } else if (ev.kind === 'log') {
      log(run, t, ev.level === 'out' ? ev.text : ev.text + '\n', ev.level);
    }
    paintProgress(run);
  }

  load();
  return { reload: load };
}
