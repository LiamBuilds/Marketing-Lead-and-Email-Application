/* ============================================================
   HAGGERTY MARKETING DASHBOARD
   Leads tab

   Self-contained. Owns its own DOM, styles and event handling,
   and reads nothing from the host page except the Supabase client.

   Wire it up in index.html:

     import { leadsPage, mountLeads } from './leads.js';

     // add to PAGES
     ['leads','Leads']

     // in the render dispatch
     case 'leads': html = leadsPage(); break;

     // immediately after app.innerHTML = html
     if (S.page === 'leads') mountLeads(sb);

   Reads  v_batch_summary, v_lead_review, verticals
   Writes nothing directly. Every change goes through n8n.
   ============================================================ */

const IMPORT_URL  = 'https://haggertybuilds.app.n8n.cloud/webhook/haggerty-lead-import';
const APPROVE_URL = 'https://haggertybuilds.app.n8n.cloud/webhook/haggerty-lead-approve';
const REJECT_URL  = 'https://haggertybuilds.app.n8n.cloud/webhook/haggerty-lead-reject';

/* Approve creates a Pipedrive org, a person and a note per contact,
   in sequence, behind one HTTP request. Forty leads in a single POST
   is a hundred and twenty Pipedrive calls and the gateway gives up
   long before that finishes. Eight at a time keeps every request well
   inside the timeout and lets the screen report progress. */
const APPROVE_CHUNK = 8;

const ROOT_ID = 'leads-root';

let sb = null;
let root = null;

const S = {
  batches: null,
  verticals: [],
  leads: null,
  batchId: 'all',
  filter: 'all',          // all | email | nosector
  selected: new Set(),
  expanded: new Set(),
  loading: false,
  err: '',
  notice: '',
  showImport: false,
  importBusy: false,
  importName: '',
  importVertical: '',
  importRows: null,
  importFile: '',
  importErr: '',
  progress: null          // { verb, done, total, failed }
};

/* ---------------- helpers ---------------- */

const esc = s => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const num = n => (n === null || n === undefined || n === '') ? '' : Number(n).toLocaleString();

function shortDate(iso){
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function initials(name){
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

function hostOf(url){
  if (!url) return '';
  try { return new URL(url.startsWith('http') ? url : 'https://' + url).hostname.replace(/^www\./, ''); }
  catch { return url; }
}

/* ---------------- CSV ---------------- */

/* Evaboot profile summaries carry commas, quotes and line breaks, so
   splitting on commas mangles roughly one row in three. This is a real
   RFC 4180 reader: quoted fields, doubled quotes, embedded newlines. */
function parseDelimited(text, delim){
  const rows = [];
  let row = [], field = '', i = 0, inQuotes = false;

  while (i < text.length){
    const ch = text[i];

    if (inQuotes){
      if (ch === '"'){
        if (text[i + 1] === '"'){ field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += ch; i++; continue;
    }

    if (ch === '"'){ inQuotes = true; i++; continue; }
    if (ch === delim){ row.push(field); field = ''; i++; continue; }
    if (ch === '\r'){ i++; continue; }
    if (ch === '\n'){ row.push(field); rows.push(row); row = []; field = ''; i++; continue; }

    field += ch; i++;
  }

  if (field !== '' || row.length){ row.push(field); rows.push(row); }
  return rows;
}

function sniffDelimiter(text){
  const line = text.split(/\r?\n/, 1)[0] || '';
  const commas = (line.match(/,/g) || []).length;
  const semis  = (line.match(/;/g) || []).length;
  const tabs   = (line.match(/\t/g) || []).length;
  if (tabs > commas && tabs > semis) return '\t';
  if (semis > commas) return ';';
  return ',';
}

/* Headers stay exactly as Evaboot wrote them. The import workflow reads
   "First Name", "Current Job", "Linkedin URL Public" and the rest by
   literal string, so renaming anything here silently empties the field. */
function csvToRows(text){
  const clean = text.replace(/^\uFEFF/, '');
  const rows = parseDelimited(clean, sniffDelimiter(clean))
    .filter(r => r.some(c => String(c).trim() !== ''));

  if (rows.length < 2) return { rows: [], headers: [] };

  const headers = rows[0].map(h => String(h).trim());
  const out = rows.slice(1).map(r => {
    const o = {};
    headers.forEach((h, idx) => { if (h) o[h] = r[idx] == null ? '' : r[idx]; });
    return o;
  });
  return { rows: out, headers };
}

/* ---------------- data ---------------- */

async function loadBatches(){
  const { data, error } = await sb
    .from('v_batch_summary').select('*')
    .order('created_at', { ascending: false })
    .limit(60);
  if (error) throw error;
  S.batches = data || [];
}

async function loadVerticals(){
  const { data, error } = await sb
    .from('verticals').select('slug,name').order('name');
  if (error) throw error;
  S.verticals = data || [];
  if (!S.importVertical && S.verticals.length) S.importVertical = S.verticals[0].slug;
}

async function loadLeads(){
  let q = sb.from('v_lead_review').select('*');
  if (S.batchId !== 'all') q = q.eq('lead_batch_id', S.batchId);
  const { data, error } = await q
    .order('fit', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(600);
  if (error) throw error;
  S.leads = data || [];

  /* Approving most and dropping a few is the normal shape of a review,
     so everything starts selected. */
  S.selected = new Set(S.leads.map(l => l.contact_id));
  S.expanded = new Set();
}

async function refresh({ leads = true, batches = true } = {}){
  S.loading = true; S.err = ''; render();
  try {
    const jobs = [];
    if (batches) jobs.push(loadBatches());
    if (leads) jobs.push(loadLeads());
    await Promise.all(jobs);
  } catch (e){
    S.err = e.message || String(e);
  } finally {
    S.loading = false; render();
  }
}

/* ---------------- actions ---------------- */

function visibleLeads(){
  const all = S.leads || [];
  if (S.filter === 'email')    return all.filter(l => l.email);
  if (S.filter === 'nosector') return all.filter(l => !l.vertical);
  return all;
}

async function postDecision(url, ids){
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ contact_ids: ids })
  });
  if (!res.ok) throw new Error('The request came back ' + res.status);
  return res.json().catch(() => ({}));
}

async function approveSelected(){
  const ids = visibleLeads()
    .filter(l => S.selected.has(l.contact_id))
    .map(l => l.contact_id);
  if (!ids.length) return;

  S.err = ''; S.notice = '';
  S.progress = { verb: 'Approving', done: 0, total: ids.length, failed: 0 };
  render();

  let failed = 0;
  for (let i = 0; i < ids.length; i += APPROVE_CHUNK){
    const slice = ids.slice(i, i + APPROVE_CHUNK);
    try {
      await postDecision(APPROVE_URL, slice);
    } catch {
      failed += slice.length;
    }
    S.progress.done = Math.min(i + slice.length, ids.length);
    S.progress.failed = failed;
    render();
  }

  const cleared = ids.length - failed;
  S.progress = null;
  S.notice = failed
    ? cleared + ' approved and pushed to Pipedrive. ' + failed + ' did not go through, and they are still sitting here to retry.'
    : cleared + ' approved and pushed to Pipedrive.';
  await refresh();
}

async function rejectSelected(){
  const ids = visibleLeads()
    .filter(l => S.selected.has(l.contact_id))
    .map(l => l.contact_id);
  if (!ids.length) return;

  S.err = ''; S.notice = '';
  S.progress = { verb: 'Rejecting', done: 0, total: ids.length, failed: 0 };
  render();

  try {
    /* One SQL update, so this does not need chunking. */
    const out = await postDecision(REJECT_URL, ids);
    S.notice = (out.rejected != null ? out.rejected : ids.length) +
      ' rejected. The records stay in the database, so the same people turning up in a later scrape are recognised rather than reviewed twice.';
  } catch (e){
    S.err = e.message || String(e);
  }

  S.progress = null;
  await refresh();
}

async function runImport(){
  if (!S.importRows || !S.importRows.length) return;

  S.importBusy = true; S.importErr = ''; S.notice = ''; render();

  let requestedBy = '';
  try {
    const { data } = await sb.auth.getUser();
    requestedBy = (data && data.user && data.user.email) || '';
  } catch { /* not fatal */ }

  try {
    const res = await fetch(IMPORT_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: S.importName.trim() || S.importFile.replace(/\.csv$/i, '') || 'Evaboot import',
        vertical_slug: S.importVertical,
        requested_by: requestedBy,
        leads: S.importRows
      })
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok || out.ok === false) throw new Error(out.error || 'The import came back ' + res.status);

    const bits = [];
    bits.push(out.inserted + ' new leads from ' + S.importRows.length + ' rows');
    if (out.matched != null)       bits.push(out.matched + ' matched in Apollo');
    if (out.new_companies)         bits.push(out.new_companies + ' new companies');
    if (out.with_email != null)    bits.push(out.with_email + ' with an email');
    if (out.skipped)               bits.push(out.skipped + ' skipped for failing your Sales Navigator filters');
    if (out.no_vertical)           bits.push(out.no_vertical + ' with no sector');

    S.notice = bits.join('. ') + '.';
    S.showImport = false;
    S.importRows = null;
    S.importFile = '';
    S.importName = '';
    if (out.batch_id) S.batchId = out.batch_id;
    await refresh();
  } catch (e){
    S.importErr = (e.message || String(e)) +
      '. Large files take a while, since every ten leads is one Apollo call. If it timed out, check the batch list before uploading again so you do not import twice.';
  } finally {
    S.importBusy = false; render();
  }
}

/* ---------------- render ---------------- */

export function leadsPage(){
  return '<div id="' + ROOT_ID + '"></div>';
}

function batchRail(){
  const bs = S.batches || [];
  const totalPending = bs.reduce((a, b) => a + Number(b.awaiting_review || 0), 0);

  const rows = bs.map(b => {
    const awaiting = Number(b.awaiting_review || 0);
    const approved = Number(b.approved_leads || b.approved || 0);
    const rejected = Number(b.rejected_leads || 0);
    const seen = approved + rejected;
    const total = seen + awaiting;
    const pct = total ? Math.round((seen / total) * 100) : 100;

    return '<button class="lb-row' + (S.batchId === b.id ? ' is-on' : '') + '" data-batch="' + esc(b.id) + '">' +
      '<span class="lb-top">' +
        '<span class="lb-name">' + esc(b.name || 'Untitled batch') + '</span>' +
        (awaiting ? '<span class="lb-count">' + awaiting + '</span>' : '<span class="lb-done">clear</span>') +
      '</span>' +
      '<span class="lb-meta">' + esc(shortDate(b.created_at)) +
        (total ? ' &middot; ' + total + ' leads' : '') +
        (b.status && b.status !== 'ready' ? ' &middot; ' + esc(b.status) : '') +
      '</span>' +
      '<span class="lb-bar"><span class="lb-fill" style="width:' + pct + '%"></span></span>' +
    '</button>';
  }).join('');

  return '<aside class="lead-rail">' +
    '<div class="lead-railhead">' +
      '<span class="lead-eyebrow">Batches</span>' +
      '<button class="lead-btn lead-btn-solid" data-act="import">Import CSV</button>' +
    '</div>' +
    '<button class="lb-row lb-all' + (S.batchId === 'all' ? ' is-on' : '') + '" data-batch="all">' +
      '<span class="lb-top">' +
        '<span class="lb-name">Everything awaiting review</span>' +
        (totalPending ? '<span class="lb-count">' + totalPending + '</span>' : '<span class="lb-done">clear</span>') +
      '</span>' +
    '</button>' +
    (rows || '<p class="lead-hint lead-pad">No batches yet. Import an Evaboot export to start one.</p>') +
  '</aside>';
}

function leadCard(l){
  const on = S.selected.has(l.contact_id);
  const open = S.expanded.has(l.contact_id);
  const noSector = !l.vertical;

  const facts = [];
  if (l.company_industry) facts.push(['Industry', l.company_industry]);
  if (l.employee_count)   facts.push(['Headcount', num(l.employee_count)]);
  if (l.company_revenue)  facts.push(['Revenue', l.company_revenue]);
  if (l.company_city || l.company_state)
    facts.push(['Location', [l.company_city, l.company_state].filter(Boolean).join(', ')]);
  if (l.territory)        facts.push(['Territory', l.territory]);
  if (l.seniority)        facts.push(['Seniority', l.seniority]);

  const factHtml = facts.map(([k, v]) =>
    '<div class="lc-fact"><dt>' + esc(k) + '</dt><dd>' + esc(v) + '</dd></div>').join('');

  const links = [];
  if (l.linkedin_url)     links.push('<a href="' + esc(l.linkedin_url) + '" target="_blank" rel="noopener">LinkedIn</a>');
  if (l.company_website)  links.push('<a href="' + esc(l.company_website) + '" target="_blank" rel="noopener">' + esc(hostOf(l.company_website)) + '</a>');

  return '<article class="lc' + (on ? ' is-on' : '') + (noSector ? ' is-flagged' : '') + '" data-id="' + esc(l.contact_id) + '">' +

    '<label class="lc-pick">' +
      '<input type="checkbox" data-pick="' + esc(l.contact_id) + '"' + (on ? ' checked' : '') + '>' +
      '<span class="lc-mark" aria-hidden="true"></span>' +
      '<span class="lc-sr">Keep ' + esc(l.full_name) + '</span>' +
    '</label>' +

    '<div class="lc-body">' +
      '<header class="lc-head">' +
        '<span class="lc-badge" aria-hidden="true">' + esc(initials(l.full_name)) + '</span>' +
        '<div class="lc-who">' +
          '<h3>' + esc(l.full_name || 'Unnamed') + '</h3>' +
          '<p>' + esc(l.title || 'No title') + (l.company_name ? ' at <strong>' + esc(l.company_name) + '</strong>' : '') + '</p>' +
        '</div>' +
        '<span class="lc-fit" title="Outreach fit score">' + (l.fit != null ? esc(l.fit) : '&ndash;') + '</span>' +
      '</header>' +

      '<div class="lc-chips">' +
        (l.vertical
          ? '<span class="lc-chip">' + esc(l.vertical) + '</span>'
          : '<span class="lc-chip lc-chip-warn">No sector</span>') +
        (l.email
          ? '<span class="lc-chip lc-chip-good">' + esc(l.email) + '</span>'
          : '<span class="lc-chip lc-chip-mute">No email</span>') +
        (l.email_status ? '<span class="lc-chip lc-chip-mute">' + esc(l.email_status) + '</span>' : '') +
        (l.office_phone ? '<span class="lc-chip lc-chip-mute">' + esc(l.office_phone) + '</span>' : '') +
      '</div>' +

      (factHtml ? '<dl class="lc-facts">' + factHtml + '</dl>' : '') +

      (open
        ? '<div class="lc-more">' +
            (l.company_description ? '<p>' + esc(l.company_description) + '</p>' : '') +
            (l.company_keywords ? '<p class="lead-hint"><strong>Keywords</strong> ' + esc(l.company_keywords) + '</p>' : '') +
            (l.bio ? '<p class="lead-hint"><strong>Profile</strong> ' + esc(l.bio) + '</p>' : '') +
            (links.length ? '<p class="lc-links">' + links.join(' &middot; ') + '</p>' : '') +
          '</div>'
        : '') +

      ((l.company_description || l.bio || links.length)
        ? '<button class="lead-link" data-more="' + esc(l.contact_id) + '">' +
            (open ? 'Less' : 'What Apollo found') + '</button>'
        : '') +
    '</div>' +
  '</article>';
}

function importPanel(){
  const opts = S.verticals.map(v =>
    '<option value="' + esc(v.slug) + '"' + (v.slug === S.importVertical ? ' selected' : '') + '>' +
    esc(v.name) + '</option>').join('');

  const ready = S.importRows && S.importRows.length;

  return '<div class="lead-sheet" role="dialog" aria-modal="true" aria-label="Import leads">' +
    '<div class="lead-sheet-in">' +
      '<div class="lead-sheet-head">' +
        '<h2>Import an Evaboot export</h2>' +
        '<button class="lead-link" data-act="closeimport">Close</button>' +
      '</div>' +

      '<label class="lead-field"><span>Batch name</span>' +
        '<input type="text" id="imp-name" value="' + esc(S.importName) + '" placeholder="Sacramento property managers, August"></label>' +

      '<label class="lead-field"><span>Sector</span>' +
        '<select id="imp-vert">' + opts + '</select></label>' +
      '<p class="lead-hint">Anything the classifier cannot place from the company data falls back to this, so pick what you actually searched for.</p>' +

      '<label class="lead-field lead-file"><span>CSV file</span>' +
        '<input type="file" id="imp-file" accept=".csv,text/csv"></label>' +

      (S.importFile
        ? '<p class="lead-hint"><strong>' + esc(S.importFile) + '</strong> &middot; ' +
          (ready ? S.importRows.length + ' rows read' : 'nothing readable in this file') + '</p>'
        : '') +

      (S.importErr ? '<p class="lead-err">' + esc(S.importErr) + '</p>' : '') +

      '<div class="lead-sheet-foot">' +
        '<button class="lead-btn lead-btn-solid" data-act="runimport"' + (ready && !S.importBusy ? '' : ' disabled') + '>' +
          (S.importBusy ? 'Enriching, this takes a minute' : 'Import ' + (ready ? S.importRows.length + ' leads' : 'leads')) +
        '</button>' +
        '<p class="lead-hint">Every ten leads is one Apollo call, so a few hundred rows takes a couple of minutes. Leave the tab open.</p>' +
      '</div>' +
    '</div>' +
  '</div>';
}

function actionBar(){
  const vis = visibleLeads();
  const picked = vis.filter(l => S.selected.has(l.contact_id)).length;

  if (S.progress){
    const p = S.progress;
    const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
    return '<div class="lead-bar lead-bar-busy">' +
      '<span class="lead-barcount">' + esc(p.verb) + ' ' + p.done + ' of ' + p.total +
        (p.failed ? ' &middot; ' + p.failed + ' failed' : '') + '</span>' +
      '<span class="lead-prog"><span class="lead-progfill" style="width:' + pct + '%"></span></span>' +
    '</div>';
  }

  if (!vis.length) return '';

  return '<div class="lead-bar">' +
    '<span class="lead-barcount"><strong>' + picked + '</strong> of ' + vis.length + ' kept</span>' +
    '<div class="lead-baracts">' +
      '<button class="lead-btn" data-act="none">Clear</button>' +
      '<button class="lead-btn" data-act="all">Select all</button>' +
      '<button class="lead-btn lead-btn-quiet" data-act="reject"' + (picked ? '' : ' disabled') + '>Reject</button>' +
      '<button class="lead-btn lead-btn-solid" data-act="approve"' + (picked ? '' : ' disabled') + '>Approve to Pipedrive</button>' +
    '</div>' +
  '</div>';
}

function render(){
  if (!root || !root.isConnected) return;

  const vis = visibleLeads();
  const all = S.leads || [];

  const filters = [['all', 'All'], ['email', 'Has email'], ['nosector', 'No sector']]
    .map(([k, label]) => {
      const n = k === 'all' ? all.length
        : k === 'email' ? all.filter(l => l.email).length
        : all.filter(l => !l.vertical).length;
      return '<button class="lead-tab' + (S.filter === k ? ' is-on' : '') + '" data-filter="' + k + '">' +
        esc(label) + '<span>' + n + '</span></button>';
    }).join('');

  let main;
  if (S.loading && !S.leads){
    main = '<p class="lead-hint lead-pad">Loading.</p>';
  } else if (!all.length){
    main = '<div class="lead-empty">' +
      '<h2>Nothing waiting</h2>' +
      '<p>Every lead in this batch has been approved or rejected. Import another Evaboot export to queue up more.</p>' +
      '<button class="lead-btn lead-btn-solid" data-act="import">Import CSV</button>' +
    '</div>';
  } else if (!vis.length){
    main = '<p class="lead-hint lead-pad">Nothing matches this filter.</p>';
  } else {
    main = '<div class="lead-cards">' + vis.map(leadCard).join('') + '</div>';
  }

  root.innerHTML =
    '<div class="lead-wrap">' +
      batchRail() +
      '<section class="lead-main">' +
        '<div class="lead-head">' +
          '<div class="lead-tabs">' + filters + '</div>' +
          '<button class="lead-link" data-act="refresh">Refresh</button>' +
        '</div>' +
        (S.notice ? '<p class="lead-note">' + esc(S.notice) + '</p>' : '') +
        (S.err ? '<p class="lead-err">' + esc(S.err) + '</p>' : '') +
        main +
      '</section>' +
    '</div>' +
    actionBar() +
    (S.showImport ? importPanel() : '');
}

/* ---------------- events ---------------- */

function onClick(e){
  const t = e.target;

  const batch = t.closest('[data-batch]');
  if (batch){
    S.batchId = batch.getAttribute('data-batch');
    S.notice = '';
    refresh({ batches: false });
    return;
  }

  const filter = t.closest('[data-filter]');
  if (filter){ S.filter = filter.getAttribute('data-filter'); render(); return; }

  const more = t.closest('[data-more]');
  if (more){
    const id = more.getAttribute('data-more');
    if (S.expanded.has(id)) S.expanded.delete(id); else S.expanded.add(id);
    render();
    return;
  }

  const act = t.closest('[data-act]');
  if (!act) return;

  switch (act.getAttribute('data-act')){
    case 'refresh':     S.notice = ''; refresh(); break;
    case 'all':         visibleLeads().forEach(l => S.selected.add(l.contact_id)); render(); break;
    case 'none':        visibleLeads().forEach(l => S.selected.delete(l.contact_id)); render(); break;
    case 'approve':     approveSelected(); break;
    case 'reject':      rejectSelected(); break;
    case 'import':      S.showImport = true; S.importErr = ''; render(); break;
    case 'closeimport': S.showImport = false; render(); break;
    case 'runimport':   runImport(); break;
  }
}

function onChange(e){
  const pick = e.target.closest('[data-pick]');
  if (pick){
    const id = pick.getAttribute('data-pick');
    if (pick.checked) S.selected.add(id); else S.selected.delete(id);
    const card = pick.closest('.lc');
    if (card) card.classList.toggle('is-on', pick.checked);
    const bar = root.querySelector('.lead-barcount strong');
    if (bar) bar.textContent = String(visibleLeads().filter(l => S.selected.has(l.contact_id)).length);
    const acts = root.querySelectorAll('[data-act="approve"],[data-act="reject"]');
    const any = visibleLeads().some(l => S.selected.has(l.contact_id));
    acts.forEach(b => { b.disabled = !any; });
    return;
  }

  if (e.target.id === 'imp-vert'){ S.importVertical = e.target.value; return; }
  if (e.target.id === 'imp-name'){ S.importName = e.target.value; return; }

  if (e.target.id === 'imp-file'){
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    S.importFile = file.name;
    S.importErr = '';
    if (!S.importName) S.importName = file.name.replace(/\.csv$/i, '');
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const { rows, headers } = csvToRows(String(reader.result || ''));
        S.importRows = rows;
        if (!rows.length){
          S.importErr = 'No data rows found. Export from Evaboot as CSV rather than XLSX.';
        } else if (!headers.includes('First Name') && !headers.includes('Full Name')){
          S.importErr = 'This does not look like an Evaboot export. The importer needs the original column headers, so upload the file exactly as Evaboot produced it.';
        }
      } catch (err){
        S.importRows = null;
        S.importErr = 'That file could not be read. ' + (err.message || '');
      }
      render();
    };
    reader.onerror = () => { S.importErr = 'That file could not be read.'; render(); };
    reader.readAsText(file);
  }
}

function onInput(e){
  if (e.target.id === 'imp-name') S.importName = e.target.value;
}

/* ---------------- mount ---------------- */

export function mountLeads(client){
  sb = client;
  root = document.getElementById(ROOT_ID);
  if (!root) return;

  if (root.dataset.wired !== '1'){
    root.dataset.wired = '1';
    root.addEventListener('click', onClick);
    root.addEventListener('change', onChange);
    root.addEventListener('input', onInput);
  }

  injectStyles();

  if (S.leads){ render(); return; }

  render();
  (async () => {
    try { await loadVerticals(); } catch { /* the dropdown can wait */ }
    await refresh();
  })();
}

/* ---------------- styles ---------------- */

function injectStyles(){
  if (document.getElementById('leads-css')) return;
  const el = document.createElement('style');
  el.id = 'leads-css';
  el.textContent = CSS;
  document.head.appendChild(el);
}

const CSS = `
#${ROOT_ID}{
  --lo: var(--orange, var(--accent, #F68922));
  --lg: var(--grey, #4D4D4D);
  --lr: var(--rule, #e4e2df);
  --lc: var(--card, #ffffff);
  --ld: var(--display, 'Oswald', 'Haas Grot Disp', 'Helvetica Neue', sans-serif);
  --lb: 'Lato', -apple-system, 'Segoe UI', Roboto, sans-serif;
  padding-bottom: 88px;
}
#${ROOT_ID} *{ box-sizing: border-box; }

.lead-wrap{ display: grid; grid-template-columns: 268px minmax(0,1fr); align-items: start; }

/* rail */
.lead-rail{ border-right: 1px solid var(--lr); min-height: 60vh; padding-bottom: 24px; }
.lead-railhead{ display:flex; align-items:center; justify-content:space-between;
  gap:10px; padding:16px 16px 12px; }
.lead-eyebrow{ font-family: var(--lb); font-size:11px; letter-spacing:.14em;
  text-transform:uppercase; color: var(--lg); opacity:.75; }

.lb-row{ display:block; width:100%; text-align:left; background:none; border:0;
  border-bottom:1px solid var(--lr); padding:12px 16px; cursor:pointer; font: inherit;
  border-left:3px solid transparent; }
.lb-row:hover{ background: rgba(0,0,0,.025); }
.lb-row.is-on{ border-left-color: var(--lo); background: rgba(246,137,34,.06); }
.lb-row:focus-visible{ outline:2px solid var(--lo); outline-offset:-2px; }
.lb-all{ border-top:1px solid var(--lr); }
.lb-top{ display:flex; align-items:baseline; justify-content:space-between; gap:8px; }
.lb-name{ font-family: var(--ld); font-size:14.5px; font-weight:600; color:#1c1c1c;
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.lb-count{ font-family: var(--lb); font-size:12px; font-weight:700; color:#fff;
  background: var(--lo); border-radius:9px; padding:1px 7px; flex:none; }
.lb-done{ font-family: var(--lb); font-size:11px; color: var(--lg); opacity:.6; flex:none; }
.lb-meta{ display:block; font-family: var(--lb); font-size:11.5px; color: var(--lg);
  opacity:.75; margin-top:3px; }
.lb-bar{ display:block; height:2px; background: var(--lr); margin-top:9px; }
.lb-fill{ display:block; height:100%; background: var(--lo); }

/* main */
.lead-main{ min-width:0; padding:16px 20px 0; }
.lead-head{ display:flex; align-items:center; justify-content:space-between; gap:12px;
  flex-wrap:wrap; margin-bottom:14px; }
.lead-tabs{ display:flex; gap:4px; flex-wrap:wrap; }
.lead-tab{ font-family: var(--lb); font-size:12.5px; background:none; cursor:pointer;
  border:1px solid var(--lr); padding:5px 11px; color: var(--lg); }
.lead-tab span{ margin-left:6px; opacity:.6; font-variant-numeric: tabular-nums; }
.lead-tab.is-on{ border-color: var(--lo); color:#1c1c1c; background: rgba(246,137,34,.08); }
.lead-tab:focus-visible{ outline:2px solid var(--lo); outline-offset:1px; }

.lead-cards{ display:flex; flex-direction:column; gap:10px; padding-bottom:24px; }

/* card */
.lc{ display:grid; grid-template-columns:38px minmax(0,1fr); background: var(--lc);
  border:1px solid var(--lr); border-left:3px solid var(--lr); }
.lc.is-on{ border-left-color: var(--lo); }
.lc.is-flagged{ border-left-color:#c0392b; }
.lc-pick{ display:flex; align-items:flex-start; justify-content:center; padding-top:17px;
  cursor:pointer; }
.lc-pick input{ position:absolute; opacity:0; width:16px; height:16px; margin:0; }
.lc-mark{ width:16px; height:16px; border:1.5px solid var(--lg); display:block; }
.lc-pick input:checked + .lc-mark{ background: var(--lo); border-color: var(--lo);
  box-shadow: inset 0 0 0 2.5px var(--lc); }
.lc-pick input:focus-visible + .lc-mark{ outline:2px solid var(--lo); outline-offset:2px; }
.lc-sr{ position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); }

.lc-body{ padding:14px 16px 14px 0; min-width:0; }
.lc-head{ display:flex; align-items:flex-start; gap:11px; }
.lc-badge{ width:32px; height:32px; flex:none; display:grid; place-items:center;
  background: var(--lg); color:#fff; font-family: var(--ld); font-size:12.5px;
  font-weight:600; letter-spacing:.04em; }
.lc-who{ min-width:0; flex:1; }
.lc-who h3{ font-family: var(--ld); font-size:16.5px; font-weight:600; margin:0;
  color:#1c1c1c; line-height:1.25; }
.lc-who p{ font-family: var(--lb); font-size:13px; color: var(--lg); margin:2px 0 0; }
.lc-fit{ font-family: var(--ld); font-size:19px; font-weight:700; color: var(--lo);
  flex:none; font-variant-numeric: tabular-nums; line-height:1; padding-top:3px; }

.lc-chips{ display:flex; flex-wrap:wrap; gap:5px; margin-top:10px; }
.lc-chip{ font-family: var(--lb); font-size:11.5px; padding:2px 8px;
  border:1px solid var(--lo); color:#8a4a08; background: rgba(246,137,34,.08); }
.lc-chip-good{ border-color:#2e7d4f; color:#1f5c39; background: rgba(46,125,79,.07); }
.lc-chip-mute{ border-color: var(--lr); color: var(--lg); background:none; }
.lc-chip-warn{ border-color:#c0392b; color:#a03024; background: rgba(192,57,43,.07); }

.lc-facts{ display:flex; flex-wrap:wrap; gap:0 22px; margin:11px 0 0; }
.lc-fact dt{ font-family: var(--lb); font-size:10.5px; letter-spacing:.1em;
  text-transform:uppercase; color: var(--lg); opacity:.7; }
.lc-fact dd{ font-family: var(--lb); font-size:13px; color:#1c1c1c; margin:1px 0 0; }

.lc-more{ margin-top:12px; padding-top:11px; border-top:1px solid var(--lr); }
.lc-more p{ font-family: var(--lb); font-size:13px; color:#333; margin:0 0 7px; line-height:1.5; }
.lc-links a{ color: var(--lo); }

/* bar */
.lead-bar{ position:sticky; bottom:0; z-index:5; display:flex; align-items:center;
  justify-content:space-between; gap:14px; flex-wrap:wrap;
  background: var(--lc); border-top:1px solid var(--lr); padding:11px 20px;
  box-shadow:0 -6px 18px rgba(0,0,0,.05); }
.lead-barcount{ font-family: var(--lb); font-size:13px; color: var(--lg); }
.lead-barcount strong{ font-family: var(--ld); font-size:17px; color:#1c1c1c; }
.lead-baracts{ display:flex; gap:8px; flex-wrap:wrap; }
.lead-bar-busy{ flex-direction:column; align-items:stretch; gap:8px; }
.lead-prog{ display:block; height:3px; background: var(--lr); }
.lead-progfill{ display:block; height:100%; background: var(--lo); transition:width .2s ease; }

/* controls */
.lead-btn{ font-family: var(--lb); font-size:13px; padding:7px 14px; cursor:pointer;
  border:1px solid var(--lg); background:none; color: var(--lg); }
.lead-btn:hover:not(:disabled){ background: rgba(0,0,0,.04); }
.lead-btn-solid{ background: var(--lo); border-color: var(--lo); color:#fff; font-weight:700; }
.lead-btn-solid:hover:not(:disabled){ filter: brightness(.94); }
.lead-btn-quiet{ border-color: var(--lr); }
.lead-btn:disabled{ opacity:.4; cursor:default; }
.lead-btn:focus-visible{ outline:2px solid var(--lo); outline-offset:2px; }
.lead-link{ font-family: var(--lb); font-size:12.5px; background:none; border:0;
  color: var(--lo); cursor:pointer; padding:6px 0; text-decoration:underline; }
.lead-link:focus-visible{ outline:2px solid var(--lo); outline-offset:2px; }

.lead-hint{ font-family: var(--lb); font-size:12.5px; color: var(--lg); opacity:.85;
  margin:6px 0; line-height:1.5; }
.lead-pad{ padding:20px; }
.lead-note{ font-family: var(--lb); font-size:13px; padding:10px 13px; margin:0 0 12px;
  border-left:3px solid #2e7d4f; background: rgba(46,125,79,.07); color:#1f5c39; }
.lead-err{ font-family: var(--lb); font-size:13px; padding:10px 13px; margin:0 0 12px;
  border-left:3px solid #c0392b; background: rgba(192,57,43,.07); color:#96271c; }

.lead-empty{ padding:52px 20px; max-width:520px; }
.lead-empty h2{ font-family: var(--ld); font-size:23px; font-weight:700; margin:0 0 6px; }
.lead-empty p{ font-family: var(--lb); font-size:14px; color: var(--lg); margin:0 0 16px; }

/* import sheet */
.lead-sheet{ position:fixed; inset:0; z-index:40; background: rgba(28,28,28,.42);
  display:flex; align-items:flex-start; justify-content:center; padding:36px 16px; overflow:auto; }
.lead-sheet-in{ width:100%; max-width:460px; background: var(--lc);
  border:1px solid var(--lr); padding:24px 26px 26px; }
.lead-sheet-head{ display:flex; align-items:baseline; justify-content:space-between; gap:12px; }
.lead-sheet-head h2{ font-family: var(--ld); font-size:21px; font-weight:700; margin:0 0 4px; }
.lead-field{ display:block; margin-top:16px; }
.lead-field span{ display:block; font-family: var(--lb); font-size:11px; letter-spacing:.1em;
  text-transform:uppercase; color: var(--lg); margin-bottom:5px; }
.lead-field input[type=text], .lead-field select{ width:100%; font-family: var(--lb);
  font-size:14px; padding:8px 10px; border:1px solid var(--lr); background:#fff; color:#1c1c1c; }
.lead-field input:focus-visible, .lead-field select:focus-visible{ outline:2px solid var(--lo);
  outline-offset:-1px; }
.lead-file input{ font-family: var(--lb); font-size:13px; }
.lead-sheet-foot{ margin-top:22px; padding-top:16px; border-top:1px solid var(--lr); }
.lead-sheet-foot .lead-btn{ width:100%; }

@media (max-width: 860px){
  .lead-wrap{ grid-template-columns:1fr; }
  .lead-rail{ border-right:0; border-bottom:1px solid var(--lr); min-height:0; }
  .lead-main{ padding:14px 14px 0; }
  .lead-bar{ padding:10px 14px; }
  .lead-baracts{ width:100%; }
  .lead-baracts .lead-btn{ flex:1 1 auto; }
}
@media (prefers-reduced-motion: reduce){
  .lead-progfill{ transition:none; }
}
`;
