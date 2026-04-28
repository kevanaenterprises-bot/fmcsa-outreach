import { useState, useEffect, useCallback } from 'react';
import { Phone, RefreshCw, Users, CheckCircle, ThumbsUp, PhoneCall } from 'lucide-react';

const API = import.meta.env.VITE_API_URL || window.location.origin;

type Carrier = {
  id: number; dot_number: string; mc_number: string; company_name: string;
  phone: string; city: string; state: string; truck_count: number;
  application_date: string; call_status: string; call_notes: string;
};
type Stats = { total: number; withPhone: number; called: number; interested: number };

const CALL_STATUSES = [
  { value: 'pending', label: 'Not Called', color: 'bg-slate-100 text-slate-600' },
  { value: 'no_answer', label: 'No Answer', color: 'bg-amber-100 text-amber-700' },
  { value: 'left_voicemail', label: 'Left Voicemail', color: 'bg-blue-100 text-blue-700' },
  { value: 'interested', label: 'Interested', color: 'bg-emerald-100 text-emerald-700' },
  { value: 'not_interested', label: 'Not Interested', color: 'bg-red-100 text-red-700' },
  { value: 'converted', label: 'Converted 🎉', color: 'bg-purple-100 text-purple-700' },
];

function CallCard({ carrier, onUpdate }: { carrier: Carrier; onUpdate: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const [status, setStatus] = useState(carrier.call_status || 'pending');
  const [notes, setNotes] = useState(carrier.call_notes || '');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    await fetch(`${API}/api/carriers/${carrier.id}/call-status`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ call_status: status, notes }),
    });
    setSaving(false);
    onUpdate();
  };

  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
      <div className="p-4 flex items-center justify-between cursor-pointer hover:bg-slate-50" onClick={() => setExpanded(!expanded)}>
        <div className="flex-1 min-w-0">
          <div className="flex items-start gap-3 flex-wrap">
            <span className="font-semibold text-slate-900 leading-tight">{carrier.company_name}</span>
            <span className={`px-2.5 py-0.5 rounded-full text-xs font-semibold flex-shrink-0 ${CALL_STATUSES.find(x => x.value === (carrier.call_status || 'pending'))?.color}`}>
              {CALL_STATUSES.find(x => x.value === (carrier.call_status || 'pending'))?.label}
            </span>
          </div>
          <div className="flex items-center gap-4 mt-1 text-sm text-slate-500 flex-wrap">
            {carrier.phone && <span>📞 {carrier.phone}</span>}
            {carrier.state && <span>📍 {carrier.city ? `${carrier.city}, ` : ''}{carrier.state}</span>}
            {carrier.truck_count && <span>🚛 {carrier.truck_count} trucks</span>}
            <span className="text-xs text-slate-400">DOT# {carrier.dot_number}</span>
          </div>
        </div>
        <div className="ml-4 flex items-center gap-2">
          {carrier.phone && (
            <a href={`tel:${carrier.phone.replace(/\D/g, '')}`} onClick={e => e.stopPropagation()}
              className="flex items-center gap-1 px-3 py-1.5 bg-emerald-600 text-white rounded-lg text-xs font-medium hover:bg-emerald-700">
              <Phone className="w-3 h-3" /> Call
            </a>
          )}
        </div>
      </div>
      {expanded && (
        <div className="border-t border-slate-100 p-4 bg-slate-50 space-y-3">
          <div>
            <label className="text-xs font-medium text-slate-500 block mb-1">Call Status</label>
            <div className="flex flex-wrap gap-2">
              {CALL_STATUSES.map(s => (
                <button key={s.value} onClick={() => setStatus(s.value)}
                  className={`px-3 py-1.5 rounded-full text-xs font-semibold border-2 transition-all ${status === s.value ? `${s.color} border-current` : 'bg-white text-slate-500 border-slate-200'}`}>
                  {s.label}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="text-xs font-medium text-slate-500 block mb-1">Notes</label>
            <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2} placeholder="Call notes..."
              className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <button onClick={save} disabled={saving}
            className="px-4 py-2 bg-blue-900 text-white rounded-lg text-sm font-medium hover:bg-blue-800 disabled:opacity-50">
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      )}
    </div>
  );
}

export default function App() {
  const [queue, setQueue] = useState<Carrier[]>([]);
  const [stats, setStats] = useState<Stats>({ total: 0, withPhone: 0, called: 0, interested: 0 });
  const [polling, setPolling] = useState(false);
  const [filter, setFilter] = useState('all');

  const load = useCallback(async () => {
    try {
      const [q, s] = await Promise.all([
        fetch(`${API}/api/call-queue`).then(r => r.json()),
        fetch(`${API}/api/stats`).then(r => r.json()),
      ]);
      setQueue(Array.isArray(q) ? q : []);
      setStats(s);
    } catch (e) { console.error(e); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const triggerPoll = async () => {
    setPolling(true);
    await fetch(`${API}/api/poll`, { method: 'POST' });
    setTimeout(() => { load(); setPolling(false); }, 5000);
  };

  const filteredQueue = filter === 'all' ? queue : queue.filter(c => (c.call_status || 'pending') === filter);

  return (
    <div className="min-h-screen bg-slate-100" style={{ fontFamily: 'system-ui, sans-serif' }}>
      <div className="bg-slate-900 px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-white font-bold text-lg m-0">FMCSA Outreach</h1>
          <p className="text-slate-400 text-sm m-0">LoadTracker Pro — New Carrier Leads</p>
        </div>
        <button onClick={triggerPoll} disabled={polling}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50">
          <RefreshCw className={`w-4 h-4 ${polling ? 'animate-spin' : ''}`} />
          {polling ? 'Polling…' : 'Poll FMCSA Now'}
        </button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 p-6 pb-4">
        {[
          { label: 'New Carriers', value: stats.total, icon: Users, color: 'text-blue-600', bg: 'bg-blue-50' },
          { label: 'Have Phone #', value: stats.withPhone, icon: PhoneCall, color: 'text-emerald-600', bg: 'bg-emerald-50' },
          { label: 'Calls Made', value: stats.called, icon: Phone, color: 'text-amber-600', bg: 'bg-amber-50' },
          { label: 'Interested', value: stats.interested, icon: ThumbsUp, color: 'text-purple-600', bg: 'bg-purple-50' },
        ].map((s, i) => (
          <div key={i} className="bg-white rounded-xl border border-slate-200 p-4 flex items-center gap-4">
            <div className={`w-10 h-10 rounded-xl ${s.bg} flex items-center justify-center flex-shrink-0`}>
              <s.icon className={`w-5 h-5 ${s.color}`} />
            </div>
            <div>
              <p className="text-2xl font-bold text-slate-900 m-0">{s.value}</p>
              <p className="text-xs text-slate-500 m-0">{s.label}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="bg-white border border-slate-200 rounded-xl mx-6 mb-6 p-6">
        <div className="flex flex-wrap gap-2 mb-4">
          {['all', ...CALL_STATUSES.map(s => s.value)].map(f => (
            <button key={f} onClick={() => setFilter(f)}
              className={`px-3 py-1.5 rounded-full text-xs font-semibold transition-colors ${filter === f ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}>
              {f === 'all' ? `All (${queue.length})` : CALL_STATUSES.find(s => s.value === f)?.label}
            </button>
          ))}
        </div>
        {filteredQueue.length === 0 ? (
          <div className="text-center py-16 text-slate-400">
            <Phone className="w-10 h-10 mx-auto mb-3 opacity-30" />
            <p className="m-0">No carriers yet. Click "Poll FMCSA Now" to fetch new entrants.</p>
          </div>
        ) : (
          <div className="space-y-3">{filteredQueue.map(c => <CallCard key={c.id} carrier={c} onUpdate={load} />)}</div>
        )}
      </div>

      <div className="text-center pb-6 text-xs text-slate-400">
        Scans FMCSA for new carrier registrations every 6 hours · Phone numbers via SAFER
      </div>
    </div>
  );
}
