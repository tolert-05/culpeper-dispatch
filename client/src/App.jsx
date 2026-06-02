import { useState, useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

const API  = import.meta.env.PROD ? '' : 'http://localhost:3003';
const POLL = 30_000;

// ── Helpers ──────────────────────────────────────────────────────

function typeClass(type = '') {
  const t = type.toUpperCase();
  if (/FIRE|SMOKE|BURN|BRUSH/.test(t))                   return 'fire';
  if (/EMS|MEDICAL|CARDIAC|CHEST|BREATH|STROKE/.test(t)) return 'ems';
  if (/ACCIDENT|MVA|CRASH|COLLISION/.test(t))            return 'mva';
  if (/RESCUE|EXTRICATION|WATER|CONFINED/.test(t))       return 'rescue';
  return '';
}

const TYPE_COLORS = { fire: '#e53e3e', ems: '#3b82f6', mva: '#d97706', rescue: '#f97316', '': '#6b7280' };

function elapsed(iso) {
  if (!iso) return '';
  const s = Math.floor((Date.now() - new Date(iso)) / 1000);
  if (s < 60)   return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

function fmtTime(str) {
  return str ? str.slice(11, 16) : '';
}

function fmtDateTime(str) {
  if (!str) return '—';
  return str.replace('T', ' ').slice(0, 16);
}

function classifyComment(msg = '') {
  const m = msg.toUpperCase();
  if (/ON SCENE|ARRIVED ON SCENE|ON-SCENE/.test(m))        return 'onscene';
  if (/ENROUTE|EN ROUTE|DISPATCHED|RESPONDING/.test(m))    return 'enroute';
  if (/AVAILABLE|IN SERVICE|CLEAR|BACK IN SERVICE/.test(m)) return 'clear';
  if (/COMPLETE|CLOSED|CANCELLED|CANCEL/.test(m))           return 'complete';
  if (/ASSIGN/.test(m))                                     return 'assign';
  return 'info';
}

function mapsUrl(lat, lng) {
  return `https://www.google.com/maps?q=${lat},${lng}`;
}

function osmEmbedUrl(lat, lng, zoom = 0.008) {
  return `https://www.openstreetmap.org/export/embed.html?bbox=${lng - zoom},${lat - zoom},${lng + zoom},${lat + zoom}&layer=mapnik&marker=${lat},${lng}`;
}

// ── Alert rules ───────────────────────────────────────────────────

const RULE_DEFAULTS = [
  { id: 'fire',   label: 'Fire / Smoke',   pattern: 'FIRE|SMOKE|BURN|BRUSH',                   enabled: true,  sound: true,  webhook: '' },
  { id: 'ems',    label: 'EMS / Medical',   pattern: 'EMS|MEDICAL|CARDIAC|CHEST|BREATH|STROKE', enabled: true,  sound: true,  webhook: '' },
  { id: 'mva',    label: 'MVA / Crash',     pattern: 'ACCIDENT|MVA|CRASH|COLLISION',            enabled: true,  sound: true,  webhook: '' },
  { id: 'rescue', label: 'Rescue',          pattern: 'RESCUE|EXTRICATION|WATER|CONFINED',       enabled: true,  sound: true,  webhook: '' },
  { id: 'all',    label: 'All Other Calls', pattern: '.*',                                      enabled: false, sound: false, webhook: '' },
];

function loadRules() {
  try { return JSON.parse(localStorage.getItem('dispatch_rules')) || RULE_DEFAULTS; }
  catch { return RULE_DEFAULTS; }
}

function playAlert(type = '') {
  try {
    const ctx  = new (window.AudioContext || window.webkitAudioContext)();
    const t    = type.toUpperCase();
    const freq = /FIRE|SMOKE/.test(t) ? 880 : /EMS|MEDICAL/.test(t) ? 660 : 520;
    for (let i = 0; i < 2; i++) {
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.frequency.value = freq;
      osc.type = 'sine';
      const s = ctx.currentTime + i * 0.45;
      gain.gain.setValueAtTime(0.3, s);
      gain.gain.exponentialRampToValueAtTime(0.001, s + 0.35);
      osc.start(s); osc.stop(s + 0.35);
    }
  } catch {}
}

function matchRule(inc, rule) {
  try { return new RegExp(rule.pattern, 'i').test(inc.type || ''); }
  catch { return false; }
}

function fireAlert(inc, rules) {
  const rule = rules.find(r => r.enabled && matchRule(inc, r));
  if (!rule) return;
  if (rule.sound) playAlert(inc.type);
  if (Notification.permission === 'granted') {
    new Notification(`${inc.type || 'DISPATCH'} — ${inc.address || ''}`, {
      body: [inc.locationName, inc.municipality].filter(Boolean).join(' · ') || 'New incident',
      tag:  inc.id,
      silent: true,
    });
  }
  if (rule.webhook) {
    fetch(rule.webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ incident: inc, rule: rule.label }),
    }).catch(() => {});
  }
}

// ── Clock ─────────────────────────────────────────────────────────

function Clock() {
  const [t, setT] = useState(new Date());
  useEffect(() => {
    const id = setInterval(() => setT(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return <span>{t.toLocaleTimeString('en-US', { hour12: false })}</span>;
}

// ── Incident map (Leaflet) ────────────────────────────────────────

function IncidentMap({ incidents, selected, onSelect }) {
  const containerRef = useRef(null);
  const lfRef        = useRef({ map: null, markers: {} });

  useEffect(() => {
    if (!containerRef.current || lfRef.current.map) return;

    const map = L.map(containerRef.current, {
      center: [38.47, -77.99],
      zoom:   11,
    });

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://openstreetmap.org" target="_blank">OpenStreetMap</a>',
      maxZoom: 19,
    }).addTo(map);

    lfRef.current.map = map;
    setTimeout(() => map.invalidateSize(), 200);

    return () => {
      map.remove();
      lfRef.current = { map: null, markers: {} };
    };
  }, []);

  // Rebuild markers when incidents or selection changes
  useEffect(() => {
    const { map, markers } = lfRef.current;
    if (!map) return;

    Object.values(markers).forEach(m => m.remove());
    lfRef.current.markers = {};

    incidents.filter(i => i.lat && i.lng).forEach(inc => {
      const color = TYPE_COLORS[typeClass(inc.type)] ?? TYPE_COLORS[''];
      const isSel = selected?.id === inc.id;
      const size  = isSel ? 20 : 13;

      const icon = L.divIcon({
        className: '',
        html: `<div style="
          width:${size}px;height:${size}px;border-radius:50%;
          background:${color};
          border:${isSel ? '3px solid #fff' : '2px solid rgba(255,255,255,0.2)'};
          box-shadow:0 0 ${isSel ? 16 : 7}px ${color}99;
        "></div>`,
        iconSize:   [size, size],
        iconAnchor: [size / 2, size / 2],
      });

      const tip = [
        `<b>${inc.type || 'UNKNOWN'}${inc.subtype ? ' · ' + inc.subtype : ''}</b>`,
        inc.locationName || '',
        inc.address,
        inc.municipality ? `[${inc.municipality}]` : '',
        inc.units?.onscene?.length  ? `On scene: ${inc.units.onscene.join(', ')}` : '',
        inc.units?.enroute?.length  ? `En route: ${inc.units.enroute.join(', ')}` : '',
      ].filter(Boolean).join('<br>');

      const marker = L.marker([inc.lat, inc.lng], { icon, zIndexOffset: isSel ? 1000 : 0 })
        .addTo(map)
        .bindTooltip(tip, { className: 'lf-tip', direction: 'right', offset: [10, 0] })
        .on('click', () => onSelect(selected?.id === inc.id ? null : inc));

      lfRef.current.markers[inc.id] = marker;
    });
  }, [incidents, selected]);

  // Pan to selected
  useEffect(() => {
    const { map } = lfRef.current;
    if (map && selected?.lat && selected?.lng) {
      map.panTo([selected.lat, selected.lng], { animate: true, duration: 0.4 });
    }
  }, [selected?.id]);

  const noCoords = incidents.filter(i => !i.lat || !i.lng);

  return (
    <div className="map-outer">
      <div ref={containerRef} className="map-container" />
      {noCoords.length > 0 && (
        <div className="map-no-loc">
          {noCoords.length} incident{noCoords.length !== 1 ? 's' : ''} without coordinates (not shown on map)
        </div>
      )}
    </div>
  );
}

// ── Alerts panel ──────────────────────────────────────────────────

function AlertsPanel({ rules, onChange, onClose }) {
  const [editingWebhook, setEditingWebhook] = useState(null);

  function toggle(id, field) {
    onChange(rules.map(r => r.id === id ? { ...r, [field]: !r[field] } : r));
  }
  function setWebhook(id, val) {
    onChange(rules.map(r => r.id === id ? { ...r, webhook: val } : r));
  }
  function testRule(rule) {
    const fake = {
      id: 'test-' + Date.now(),
      type: rule.id === 'all' ? 'TEST CALL' : rule.id.toUpperCase().replace('_', ' '),
      address: '123 Test St', locationName: '', municipality: '',
    };
    fireAlert(fake, [{ ...rule, enabled: true }]);
  }

  return (
    <div className="alerts-overlay" onClick={onClose}>
      <div className="alerts-panel" onClick={e => e.stopPropagation()}>
        <div className="alerts-head">
          <span className="alerts-title">Alert Rules</span>
          <button className="close-btn" onClick={onClose}>✕</button>
        </div>

        {Notification.permission !== 'granted' && (
          <button className="perm-btn" onClick={() => Notification.requestPermission().then(() => onChange([...rules]))}>
            Enable Browser Notifications
          </button>
        )}

        <div className="alerts-rules">
          {rules.map(r => (
            <div key={r.id} className={`alert-rule ${r.enabled ? 'rule-on' : ''}`}>
              <div className="rule-row">
                <span className={`rule-label rule-${r.id}`}>{r.label}</span>
                <div className="rule-controls">
                  <label className="rule-chk">
                    <input type="checkbox" checked={r.enabled} onChange={() => toggle(r.id, 'enabled')} />
                    <span>notify</span>
                  </label>
                  <label className="rule-chk">
                    <input type="checkbox" checked={r.sound} onChange={() => toggle(r.id, 'sound')} />
                    <span>sound</span>
                  </label>
                  <button className="test-btn" onClick={() => testRule(r)}>test</button>
                  <button
                    className={`webhook-toggle ${r.webhook ? 'webhook-active' : ''}`}
                    onClick={() => setEditingWebhook(editingWebhook === r.id ? null : r.id)}
                    title="Webhook"
                  >
                    {r.webhook ? 'hook✓' : 'hook'}
                  </button>
                </div>
              </div>
              {editingWebhook === r.id && (
                <input
                  className="webhook-input"
                  type="url"
                  placeholder="https://hooks.zapier.com/... (POSTs JSON on match)"
                  value={r.webhook}
                  onChange={e => setWebhook(r.id, e.target.value)}
                  autoFocus
                />
              )}
            </div>
          ))}
        </div>
        <div className="alerts-note">
          Rules save automatically · sounds need a click first · webhook receives {'{incident, rule}'}
        </div>
      </div>
    </div>
  );
}

// ── Compact card ──────────────────────────────────────────────────

function IncidentCard({ inc, selected, onClick }) {
  const cls      = typeClass(inc.type);
  const onscene  = inc.units?.onscene  ?? [];
  const enroute  = inc.units?.enroute  ?? [];
  const avail    = inc.units?.available ?? [];
  const total    = onscene.length + enroute.length + avail.length;
  const recent   = inc.comments?.[0];

  return (
    <div
      className={`card ${cls} ${selected ? 'card-selected' : ''} ${inc.closed ? 'card-closed' : ''}`}
      onClick={onClick}
    >
      <div className="card-top">
        <div className="card-type-block">
          <span className={`card-type ${cls}`}>{inc.type || 'UNKNOWN'}</span>
          {inc.subtype && <span className="card-subtype">{inc.subtype}</span>}
        </div>
        <div className="card-badges">
          {inc.priority && <span className="badge-p">P{inc.priority}</span>}
          {inc.closed   && <span className="badge-closed">CLOSED</span>}
          <span className="badge-time">{elapsed(inc.arrivedOn)}</span>
        </div>
      </div>

      {inc.locationName && <div className="card-loc">{inc.locationName}</div>}
      <div className="card-addr">{inc.address}</div>
      {(inc.municipality || inc.crossStreet) && (
        <div className="card-meta-row">
          {inc.municipality && <span className="card-munic">{inc.municipality}</span>}
          {inc.crossStreet  && <span className="card-cross">✕ {inc.crossStreet}</span>}
        </div>
      )}

      <div className="card-units">
        {onscene.length > 0 && <span className="unit-pill onscene">{onscene.length} on scene</span>}
        {enroute.length > 0 && <span className="unit-pill enroute">{enroute.length} en route</span>}
        {avail.length > 0   && <span className="unit-pill">{avail.length} avail</span>}
        {total === 0        && <span className="unit-pill dim-pill">no units assigned</span>}
      </div>

      {recent && (
        <div className="card-recent">
          <span className="card-recent-time">{fmtTime(recent.createdAt)}</span>
          <span className="card-recent-msg">{recent.message}</span>
        </div>
      )}
    </div>
  );
}

// ── Detail panel ──────────────────────────────────────────────────

function DetailPanel({ inc, onClose }) {
  const cls = typeClass(inc.type);
  const { onscene = [], enroute = [], available = [] } = inc.units || {};
  const totalUnits = onscene.length + enroute.length + available.length;

  // Fetch radio calls for this incident's time window
  const [radioCalls, setRadioCalls] = useState([]);
  const { audio, playingId, play } = useRadioPlayer();
  useEffect(() => {
    if (!inc.arrivedOn) return;
    const anchor = new Date(inc.arrivedOn).getTime();
    if (isNaN(anchor)) return;
    fetchRadioCalls(anchor - 30 * 60 * 1000)
      .then(data => setRadioCalls(data.filter(c => omzTs(c) <= anchor + 90 * 60 * 1000)))
      .catch(() => {});
  }, [inc.id]);

  // Merge dispatch comments + radio calls into one sorted timeline
  const dispatchEntries = [...(inc.comments || [])].map(c => ({
    _kind: 'dispatch',
    ts: new Date(c.createdAtISO || c.createdAt || 0).getTime(),
    data: c,
  }));
  const radioEntries = radioCalls.map(c => ({
    _kind: 'radio',
    ts: omzTs(c),
    data: c,
  }));
  const mergedTimeline = [...dispatchEntries, ...radioEntries]
    .sort((a, b) => a.ts - b.ts);

  return (
    <div className="detail">
      <div className="detail-header">
        <div className="detail-header-left">
          <div className="detail-type-block">
            <span className={`detail-type ${cls}`}>{inc.type || 'UNKNOWN'}</span>
            {inc.subtype && <span className="detail-subtype">{inc.subtype}</span>}
          </div>
          <div className="detail-badges">
            {inc.priority && <span className="badge-p">P{inc.priority}</span>}
            {inc.closed   && <span className="badge-closed">CLOSED</span>}
          </div>
        </div>
        <button className="close-btn" onClick={onClose}>✕</button>
      </div>

      <div className="detail-body">

        {/* Location */}
        <div className="detail-section">
          {inc.locationName && <div className="detail-loc-name">{inc.locationName}</div>}
          <div className="detail-address">{inc.address}</div>
          {inc.crossStreet  && <div className="detail-cross">✕ Cross: {inc.crossStreet}</div>}
          <div className="detail-meta-row">
            {inc.municipality && <span className="detail-meta-item">{inc.municipality}{inc.zipCode ? ` ${inc.zipCode}` : ''}</span>}
            {inc.approximated && <span className="detail-meta-item warn-text">⚠ Approx. location</span>}
          </div>
          <div className="detail-meta-row">
            <span className="detail-meta-item">Dispatched {fmtDateTime(inc.arrivedOn)}</span>
            <span className="detail-meta-item elapsed-badge">{elapsed(inc.arrivedOn)} elapsed</span>
          </div>
          <div className="detail-meta-row">
            {inc.cadId && <span className="detail-meta-item cad-id">CAD# {inc.cadId}</span>}
            {inc.typeCode && <span className="detail-meta-item dim-text">Type {inc.typeCode}{inc.subtypeCode ? ' · ' + inc.subtypeCode : ''}</span>}
            <span className="detail-meta-item dim-text">IAR# {inc.id}</span>
          </div>
          {inc.lat && (
            <div className="detail-meta-row">
              <a className="detail-meta-link" href={mapsUrl(inc.lat, inc.lng)} target="_blank" rel="noreferrer">
                Open in Google Maps ↗
              </a>
            </div>
          )}
        </div>

        {/* Inline map */}
        {inc.lat && inc.lng && (
          <div className="detail-section">
            <div className="detail-section-label">MAP</div>
            <iframe
              title="incident map"
              loading="lazy"
              src={osmEmbedUrl(inc.lat, inc.lng)}
              className="detail-map-frame"
            />
          </div>
        )}

        {/* Unit summary */}
        <div className="detail-section">
          <div className="detail-section-label">
            UNITS{totalUnits > 0 ? ` — ${totalUnits} total` : ''}
          </div>
          {onscene.length > 0 && (
            <div className="unit-row">
              <span className="unit-row-label onscene-label">ON SCENE</span>
              <div className="unit-tags">
                {onscene.map((u, i) => <span key={i} className="unit-tag onscene">{u}</span>)}
              </div>
            </div>
          )}
          {enroute.length > 0 && (
            <div className="unit-row">
              <span className="unit-row-label enroute-label">EN ROUTE</span>
              <div className="unit-tags">
                {enroute.map((u, i) => <span key={i} className="unit-tag enroute">{u}</span>)}
              </div>
            </div>
          )}
          {available.length > 0 && (
            <div className="unit-row">
              <span className="unit-row-label">AVAILABLE</span>
              <div className="unit-tags">
                {available.map((u, i) => <span key={i} className="unit-tag">{u}</span>)}
              </div>
            </div>
          )}
          {totalUnits === 0 && <div className="empty">NO UNITS ASSIGNED</div>}
        </div>

        {/* Caller info */}
        {(inc.callerInfo?.phoneNumber || inc.callerName || inc.callerLat) && (
          <div className="detail-section">
            <div className="detail-section-label">CALLER</div>
            <div className="detail-caller">
              {inc.callerInfo?.phoneNumber && <span>{inc.callerInfo.phoneNumber}</span>}
              {(inc.callerName || inc.callerInfo?.name) && <span>{inc.callerName || inc.callerInfo.name}</span>}
              {inc.callerInfo?.createdAt && <span className="dim-text">{fmtTime(inc.callerInfo.createdAt)}</span>}
            </div>
            {inc.callerLat && (
              <div className="caller-gps">
                <span className="caller-gps-label">📱 Caller GPS</span>
                <span>{inc.callerLat.toFixed(5)}, {inc.callerLng.toFixed(5)}</span>
                {inc.callerAccuracy && <span className="caller-accuracy">±{inc.callerAccuracy}m</span>}
                {inc.callerLocTime && <span className="dim-text">{inc.callerLocTime}</span>}
                <a className="detail-meta-link" href={mapsUrl(inc.callerLat, inc.callerLng)} target="_blank" rel="noreferrer">map ↗</a>
              </div>
            )}
          </div>
        )}

        {/* Responders */}
        {inc.responders?.length > 0 && (
          <div className="detail-section">
            <div className="detail-section-label">RESPONDING MEMBERS ({inc.responders.length})</div>
            <div className="responder-grid">
              {inc.responders.map((r, i) => (
                <div key={i} className="responder">
                  <span className="responder-name">{r.memberName} {r.memberLastName}</span>
                  {r.position && <span className="responder-pos">{r.position}</span>}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Unified timeline: dispatch log + radio traffic */}
        <div className="detail-section">
          <div className="detail-section-label">
            INCIDENT TIMELINE — {mergedTimeline.length} entries
            {radioCalls.length > 0 && <span className="tl-radio-count"> · {radioCalls.length} radio</span>}
          </div>
          {audio}
          {mergedTimeline.length === 0 && <div className="empty">NO TIMELINE DATA</div>}
          <div className="timeline">
            {mergedTimeline.map((entry, i) => {
              if (entry._kind === 'radio') {
                const c = entry.data;
                const isPlaying = playingId === c._id;
                return (
                  <div key={`r-${c._id}`} className={`tl-entry tl-radio ${isPlaying ? 'tl-radio-playing' : ''}`}>
                    <span className="tl-time">{fmtTime(c.time)}</span>
                    <button className="tl-radio-btn" onClick={() => play(c)}>
                      {isPlaying ? '⏹' : '▶'}
                    </button>
                    <span className="tl-msg">{omzName(c)}</span>
                    <span className="tl-by">{fmtDur(omzDur(c))}</span>
                  </div>
                );
              }
              const c = entry.data;
              const kind = classifyComment(c.message);
              return (
                <div key={`d-${i}`} className={`tl-entry tl-${kind} ${c.createdBy === 'CAD' ? 'tl-cad' : ''}`}>
                  <span className="tl-time">{fmtTime(c.createdAt)}</span>
                  <span className="tl-msg">{c.message}</span>
                  {c.createdBy && (
                    <span className="tl-by">{c.createdBy === 'CAD' ? 'CAD' : c.createdBy.split(' - ')[1] || c.createdBy}</span>
                  )}
                </div>
              );
            })}
          </div>
        </div>

      </div>
    </div>
  );
}

// ── Section ───────────────────────────────────────────────────────

function Section({ label, incidents, selected, onSelect }) {
  return (
    <section>
      <div className="section-header">
        <span className="section-label">{label}</span>
        <span className="section-count">{incidents.length}</span>
      </div>
      {incidents.length === 0
        ? <div className="empty">NONE</div>
        : incidents.map(i => (
            <IncidentCard
              key={i.id}
              inc={i}
              selected={selected?.id === i.id}
              onClick={() => onSelect(selected?.id === i.id ? null : i)}
            />
          ))
      }
    </section>
  );
}

// ── OpenMHz Radio ─────────────────────────────────────────────────

const OMZ_BASE = 'https://api.openmhz.com/culpeper';

const TIME_RANGES = [
  { label: '30m',  ms: 30  * 60 * 1000 },
  { label: '1hr',  ms: 60  * 60 * 1000 },
  { label: '4hr',  ms: 4   * 60 * 60 * 1000 },
  { label: '12hr', ms: 12  * 60 * 60 * 1000 },
  { label: '24hr', ms: 24  * 60 * 60 * 1000 },
];

function fmtDur(sec) {
  if (!sec) return '';
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m${sec % 60 ? sec % 60 + 's' : ''}`;
}

// OpenMHz actual field names (confirmed from API):
// talkgroupNum, time (ISO string), len, url (full URL)
function omzTs(call)   { const t = call.time; return t ? new Date(t).getTime() : 0; }
function omzDur(call)  { return call.len ?? 0; }
function omzTg(call)   { return call.talkgroupNum; }
function omzName(call) { return call.talkgroupName || call.talkgroupLabel || (call.talkgroupNum != null ? `TG ${call.talkgroupNum}` : 'Unknown'); }
function omzAudioUrl(call) { return call.url || null; }

async function fetchRadioCalls(sinceMs, tgFilter = '') {
  const sinceUnix = Math.floor(sinceMs / 1000);
  let url = `${OMZ_BASE}/calls/newer?time=${sinceUnix}`;
  if (tgFilter.trim()) {
    url += `&filter-type=talkgroup&filter-code=${encodeURIComponent(tgFilter.trim())}`;
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`OpenMHz HTTP ${res.status}`);
  const data = await res.json();
  const calls = data.calls || [];
  return calls.sort((a, b) => omzTs(b) - omzTs(a));
}

function CallRow({ call, playingId, onPlay }) {
  const ts = omzTs(call);
  const t = ts ? new Date(ts * 1000) : null;
  const timeStr = t ? t.toLocaleTimeString('en-US', { hour12: false }) : '—';
  const isPlaying = playingId === call._id;
  const tgName = omzName(call);

  return (
    <div className={`radio-call ${isPlaying ? 'radio-call-active' : ''}`}>
      <button className="radio-play-btn" onClick={() => onPlay(call)}>
        {isPlaying ? '⏹' : '▶'}
      </button>
      <div className="radio-call-info">
        <span className="radio-call-tg">{tgName}</span>
        <span className="radio-call-time">{timeStr}</span>
      </div>
      <span className="radio-call-dur">{fmtDur(omzDur(call))}</span>
    </div>
  );
}

function useRadioPlayer() {
  const audioRef    = useRef(null);
  const [playingId,  setPlayingId]  = useState(null);
  const [playingUrl, setPlayingUrl] = useState(null);

  function play(call) {
    const url = omzAudioUrl(call);
    if (!url) return;
    if (playingId === call._id) {
      audioRef.current?.pause();
      setPlayingId(null); setPlayingUrl(null);
    } else {
      setPlayingId(call._id); setPlayingUrl(url);
    }
  }

  useEffect(() => {
    if (playingUrl && audioRef.current) {
      audioRef.current.load();
      audioRef.current.play().catch(() => {});
    }
  }, [playingUrl]);

  const audio = <audio ref={audioRef} src={playingUrl || ''} onEnded={() => setPlayingId(null)} />;
  return { audio, playingId, play };
}

function RadioPanel({ onClose }) {
  const [calls,    setCalls]    = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [error,    setError]    = useState(null);
  const [range,    setRange]    = useState(TIME_RANGES[1]);
  const [tgFilter, setTgFilter] = useState('');
  const { audio, playingId, play } = useRadioPlayer();

  async function load(r, tg) {
    setLoading(true); setError(null);
    try {
      const data = await fetchRadioCalls(Date.now() - r.ms, tg);
      setCalls(data);
    } catch(e) { setError(e.message); }
    finally { setLoading(false); }
  }

  useEffect(() => { load(range, tgFilter); }, []);

  useEffect(() => {
    const t = setInterval(() => load(range, tgFilter), 60_000);
    return () => clearInterval(t);
  }, [range, tgFilter]);

  function applyRange(r) { setRange(r); load(r, tgFilter); }
  function applyFilter()  { load(range, tgFilter); }

  return (
    <div className="alerts-overlay" onClick={onClose}>
      <div className="radio-panel" onClick={e => e.stopPropagation()}>
        {audio}
        <div className="alerts-head">
          <span className="alerts-title">Radio Traffic — OpenMHz · Culpeper</span>
          <button className="close-btn" onClick={onClose}>✕</button>
        </div>

        <div className="radio-filters">
          <div className="radio-range-btns">
            {TIME_RANGES.map(r => (
              <button
                key={r.label}
                className={`radio-range-btn ${range.label === r.label ? 'range-active' : ''}`}
                onClick={() => applyRange(r)}
              >{r.label}</button>
            ))}
          </div>
          <div className="radio-tg-row">
            <input
              className="radio-tg-input"
              type="text"
              placeholder="Talkgroup IDs, comma-separated (e.g. 45820,46160)"
              value={tgFilter}
              onChange={e => setTgFilter(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && applyFilter()}
            />
            <button className="radio-tg-go" onClick={applyFilter}>go</button>
          </div>
        </div>

        <div className="radio-calls">
          {loading && <div className="radio-status">Loading…</div>}
          {error   && <div className="radio-status radio-error">{error}</div>}
          {!loading && !error && calls.length === 0 && (
            <div className="radio-status">No calls in this time range</div>
          )}
          {calls.map(c => (
            <CallRow key={c._id} call={c} playingId={playingId} onPlay={play} />
          ))}
        </div>

        <div className="alerts-note">
          {calls.length} calls · refreshes every 60s · <a className="detail-meta-link" href="https://openmhz.com/system/culpeper" target="_blank" rel="noreferrer">openmhz ↗</a>
        </div>
      </div>
    </div>
  );
}

function RadioTraffic({ inc }) {
  const [calls,   setCalls]   = useState([]);
  const [loading, setLoading] = useState(true);
  const { audio, playingId, play } = useRadioPlayer();

  useEffect(() => {
    if (!inc.arrivedOn) { setLoading(false); return; }
    const anchor = new Date(inc.arrivedOn).getTime();
    if (isNaN(anchor)) { setLoading(false); return; }
    const since = anchor - 30 * 60 * 1000;
    const until = anchor + 90 * 60 * 1000;
    fetchRadioCalls(since)
      .then(data => setCalls(data.filter(c => omzTs(c) <= until)))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [inc.id]);

  if (loading) return <div className="radio-status">Loading…</div>;
  if (!calls.length) return <div className="empty">NO RADIO TRAFFIC FOUND</div>;

  return (
    <div className="radio-incident-calls">
      {audio}
      {calls.map(c => <CallRow key={c._id} call={c} playingId={playingId} onPlay={play} />)}
    </div>
  );
}

// ── Scanner ───────────────────────────────────────────────────────

const STREAM_URL = 'https://broadcastify.cdnstream1.com/26919';

function ScannerBar({ onClose }) {
  const audioRef = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [volume,  setVolume]  = useState(0.8);
  const [error,   setError]   = useState(null);

  function toggle() {
    const a = audioRef.current;
    if (!a) return;
    if (playing) {
      a.pause();
      setPlaying(false);
    } else {
      setError(null);
      a.play().then(() => setPlaying(true)).catch(e => setError(e.message));
    }
  }

  function onVol(e) {
    const v = parseFloat(e.target.value);
    setVolume(v);
    if (audioRef.current) audioRef.current.volume = v;
  }

  return (
    <div className="scanner-bar">
      <audio ref={audioRef} src={STREAM_URL} preload="none" onError={() => setError('Stream unavailable')} />
      <div className="scanner-bar-head">
        <span className={`scanner-dot ${playing ? 'scanner-live' : ''}`} />
        <span className="scanner-label">CULPEPER CO. FIRE/EMS SCANNER</span>
        <a className="scanner-ext" href="https://www.broadcastify.com/listen/feed/26919" target="_blank" rel="noreferrer">broadcastify ↗</a>
        <button className="close-btn" onClick={() => { audioRef.current?.pause(); onClose(); }}>✕</button>
      </div>
      <div className="scanner-body">
        <button className={`scanner-play-btn ${playing ? 'scanner-playing' : ''}`} onClick={toggle}>
          {playing ? '⏹ STOP' : '▶ PLAY'}
        </button>
        <div className="scanner-vol">
          <span className="scanner-vol-label">VOL</span>
          <input type="range" min="0" max="1" step="0.05" value={volume} onChange={onVol} className="scanner-vol-slider" />
        </div>
        {error && <span className="scanner-error">{error}</span>}
        {playing && <span className="scanner-live-label">● LIVE</span>}
      </div>
    </div>
  );
}

// ── App ───────────────────────────────────────────────────────────

export default function App() {
  const [data, setData]             = useState(null);
  const [error, setError]           = useState(null);
  const [selected, setSelected]     = useState(null);
  const [showRaw, setShowRaw]       = useState(false);
  const [rawText, setRawText]       = useState('');
  const [rules, setRules]           = useState(loadRules);
  const [showAlerts,  setShowAlerts]  = useState(false);
  const [showMap,     setShowMap]     = useState(false);
  const [showScanner, setShowScanner] = useState(false);
  const [showRadio,   setShowRadio]   = useState(false);
  const rulesRef = useRef(rules);
  const timer    = useRef(null);

  useEffect(() => {
    rulesRef.current = rules;
    localStorage.setItem('dispatch_rules', JSON.stringify(rules));
  }, [rules]);

  useEffect(() => {
    if (Notification.permission === 'default') Notification.requestPermission();
    const es = new EventSource(`${API}/stream`);
    es.onmessage = e => {
      try {
        const d = JSON.parse(e.data);
        if (Array.isArray(d)) d.forEach(inc => fireAlert(inc, rulesRef.current));
      } catch {}
    };
    return () => es.close();
  }, []);

  async function load() {
    try {
      const res  = await fetch(`${API}/incidents`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setData(json);
      setError(null);
      if (selected) {
        const refreshed = json.all?.find(i => i.id === selected.id);
        if (refreshed) setSelected(refreshed);
      }
    } catch (e) { setError(e.message); }
  }

  useEffect(() => {
    load();
    timer.current = setInterval(load, POLL);
    return () => clearInterval(timer.current);
  }, []);

  useEffect(() => {
    if (!showRaw) return;
    fetch(`${API}/raw`).then(r => r.text()).then(setRawText);
  }, [showRaw]);

  const active  = data?.active  ?? [];
  const closed  = data?.closed  ?? [];
  const status  = data?.status  ?? 'starting';
  const syncT   = data?.lastSync
    ? new Date(data.lastSync).toLocaleTimeString('en-US', { hour12: false })
    : '—';
  const dotCls  = error ? 'error' : status === 'ok' ? '' : 'warn';

  return (
    <div className="layout">

      {/* Header */}
      <div className="header">
        <div className="header-left">
          <span className="header-title">Culpeper County Dispatch</span>
          <span className="header-div">|</span>
          <span className="header-agency">{data?.agency ?? 'RICHARDSVILLE'}</span>
        </div>
        <div className="header-right">
          <span
            className={`header-btn ${showRadio ? 'btn-active' : ''}`}
            onClick={() => setShowRadio(s => !s)}
          >
            radio
          </span>
          <span
            className={`header-btn ${showScanner ? 'btn-active' : ''}`}
            onClick={() => setShowScanner(s => !s)}
          >
            scanner
          </span>
          <span
            className={`header-btn ${showMap ? 'btn-active' : ''}`}
            onClick={() => setShowMap(s => !s)}
          >
            {showMap ? 'list' : 'map'}
          </span>
          <span
            className={`header-btn ${rules.some(r => r.enabled) ? 'alerts-on' : ''}`}
            onClick={() => setShowAlerts(s => !s)}
          >
            alerts{rules.some(r => r.enabled) ? ` (${rules.filter(r => r.enabled).length})` : ''}
          </span>
          <span className="header-btn hide-mobile" onClick={() => setShowRaw(s => !s)}>
            {showRaw ? 'hide raw' : 'raw'}
          </span>
          <span className="hide-mobile">sync {syncT}</span>
          <Clock />
          <span className={`live-dot ${dotCls}`}>
            {error ? 'OFFLINE' : status === 'ok' ? 'LIVE' : status.replace(/_/g, ' ')}
          </span>
        </div>
      </div>

      {/* Body */}
      <div className="body">

        {showMap ? (
          /* ── Map view ── */
          <div className="map-body">
            <IncidentMap
              incidents={active}
              selected={selected}
              onSelect={setSelected}
            />
            {selected && (
              <div className="map-detail-overlay">
                <DetailPanel inc={selected} onClose={() => setSelected(null)} />
              </div>
            )}
          </div>
        ) : (
          /* ── List view ── */
          <>
            <div className={`list ${selected ? 'list-narrow' : ''}`}>
              {error && (
                <div className="status-msg">
                  SERVER OFFLINE — {error}
                  <div style={{ fontSize: '10px', marginTop: '6px' }}>npm run dev</div>
                </div>
              )}
              {!error && (status === 'authenticating' || status === 'starting') && (
                <div className="status-msg">
                  AUTHENTICATING WITH IAR…
                  <div style={{ fontSize: '10px', marginTop: '4px' }}>May take 15–30 seconds</div>
                </div>
              )}
              {!error && status === 'auth_error' && (
                <div className="status-msg">AUTH FAILED — CHECK .env</div>
              )}
              {!error && (status === 'ok' || data) && (
                <>
                  <Section label="Active Incidents" incidents={active} selected={selected} onSelect={setSelected} />
                  {closed.length > 0 && (
                    <Section label="Closed / Recent" incidents={closed} selected={selected} onSelect={setSelected} />
                  )}
                  {showRaw && (
                    <section>
                      <div className="section-header">
                        <span className="section-label">Raw API Response</span>
                      </div>
                      <div className="debug">{rawText || 'loading…'}</div>
                    </section>
                  )}
                </>
              )}
            </div>

            {selected && (
              <DetailPanel inc={selected} onClose={() => setSelected(null)} />
            )}
          </>
        )}

      </div>

      {/* Footer */}
      <div className="footer">
        <span>IAR · COORDINATOR API · {POLL / 1000}S POLL · SSE LIVE</span>
        <span>{(data?.all ?? []).length} incidents · {active.length} active</span>
      </div>

      {showScanner && (
        <ScannerBar onClose={() => setShowScanner(false)} />
      )}

      {showRadio && <RadioPanel onClose={() => setShowRadio(false)} />}

      {showAlerts && (
        <AlertsPanel rules={rules} onChange={setRules} onClose={() => setShowAlerts(false)} />
      )}

    </div>
  );
}
