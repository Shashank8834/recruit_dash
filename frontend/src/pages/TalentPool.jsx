import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { formatDate, formatRelative } from '../lib/utils';
import { readJson, errorFrom } from '../lib/api';
import TruncatedList from '../components/TruncatedList';

/**
 * The talent pool: CVs uploaded here, and candidates typed in by hand.
 *
 * Deliberately its own screen, with its own table, kept apart from the
 * WhatsApp candidate list. The two hold different things — a curated record
 * versus an inbound message — and mixing them would make it impossible to tell
 * at a glance which is which.
 *
 * Two ways in, because there are two ways candidates actually arrive. A CV is
 * a document to parse; a referral is a name and a number someone was told over
 * the phone. Only supporting the first pushed the second into a private
 * spreadsheet, where the matcher could never see it.
 */

const BLANK = {
  name: '', email: '', phone: '', currentCompany: '', currentDesignation: '',
  location: '', age: '', experienceYears: '', qualifications: '', note: '',
  salaryText: '', domainExpertise: '', skills: '', companyListingStatus: '',
  employeeType: '', referredBy: '',
};

/**
 * How an employee type reads on screen. Stored as 'non_elite' because it is a
 * value in a check constraint; written with a hyphen because that is how it is
 * said out loud.
 */
const EMPLOYEE_TYPES = [
  { value: 'elite', label: 'Elite' },
  { value: 'non_elite', label: 'Non-elite' },
];

function employeeTypeLabel(value) {
  return (EMPLOYEE_TYPES.find((t) => t.value === value) || {}).label || null;
}

export default function TalentPool() {
  const [candidates, setCandidates] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');
  const [minExperience, setMinExperience] = useState('');
  const [salaryFrom, setSalaryFrom] = useState('');
  const [salaryTo, setSalaryTo] = useState('');
  const [domain, setDomain] = useState('');
  const [skill, setSkill] = useState('');
  const [listingStatus, setListingStatus] = useState('');
  const [employeeType, setEmployeeType] = useState('');

  const [uploading, setUploading] = useState(false);
  const [uploadResult, setUploadResult] = useState(null);
  const fileInput = useRef(null);

  const [entering, setEntering] = useState(false);
  const [form, setForm] = useState(BLANK);
  const [saving, setSaving] = useState(false);
  // Kept apart from the page-level `error` above, which renders in the header
  // — a hundred lines and four textareas above the button that causes this
  // one. A refusal shown there is off-screen for anyone who has just filled
  // the form in, so the submit appears to do nothing at all.
  const [formError, setFormError] = useState(null);
  const formErrorRef = useRef(null);

  const navigate = useNavigate();

  const params = () => {
    const p = new URLSearchParams();
    if (search.trim()) p.set('search', search.trim());
    if (minExperience) p.set('minExperience', minExperience);
    if (salaryFrom.trim()) p.set('salaryFrom', salaryFrom.trim());
    if (salaryTo.trim()) p.set('salaryTo', salaryTo.trim());
    if (domain.trim()) p.set('domain', domain.trim());
    if (skill.trim()) p.set('skill', skill.trim());
    if (listingStatus) p.set('listingStatus', listingStatus);
    if (employeeType) p.set('employeeType', employeeType);
    return p;
  };

  const load = useCallback(() => {
    setLoading(true);
    fetch(`/api/candidates?${params()}`)
      .then(readJson)
      .then((d) => { setCandidates(d.candidates || []); setTotal(d.total || 0); setLoading(false); })
      .catch((e) => { setError(e.message); setLoading(false); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, minExperience, salaryFrom, salaryTo, domain, skill, listingStatus, employeeType]);

  // Debounced: typing in the search box should not fire a query per keystroke.
  useEffect(() => {
    const timer = setTimeout(load, 250);
    return () => clearTimeout(timer);
  }, [load]);

  // Brought into view rather than merely rendered. The message sits at the
  // bottom of a long form, but a duplicate is most often caught on a short one
  // — a name and a phone number — where the button is still high up the page
  // and the panel has grown downwards past the fold.
  //
  // Jumped, not animated. `behavior: 'smooth'` is not honoured everywhere —
  // where it is ignored the scroll does not happen at all, which is the one
  // outcome this exists to prevent — and a refusal is something to read now
  // rather than to watch travel up the page.
  useEffect(() => {
    if (formError && formErrorRef.current) {
      formErrorRef.current.scrollIntoView({ block: 'center' });
    }
  }, [formError]);

  async function onUpload(event) {
    const files = Array.from(event.target.files || []);
    if (files.length === 0) return;

    // Named for what it is rather than `form`, which is now the hand-entry
    // form's state a few lines up.
    const payload = new FormData();
    files.forEach((f) => payload.append('files', f));

    setUploading(true);
    setUploadResult(null);
    try {
      const response = await fetch('/api/candidates', { method: 'POST', body: payload });
      // Not every failure comes from the app. A file over the proxy's limit is
      // rejected by nginx with an HTML error page, and calling .json() on that
      // throws a parse error that tells the user nothing about the real cause.
      const body = await response.text();
      let data;
      try {
        data = JSON.parse(body);
      } catch {
        throw new Error(
          response.status === 413
            ? 'That file is too large for the server to accept.'
            : `Upload failed (HTTP ${response.status}).`
        );
      }
      // 207 means some files worked and some did not, so the result is
      // reported either way rather than treated as a plain success or failure.
      setUploadResult(data);
      load();
    } catch (err) {
      setUploadResult({ stored: 0, failed: files.length, errors: [{ file: '', error: err.message }] });
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  async function createManual(event) {
    event.preventDefault();
    if (!form.name.trim()) return;

    setSaving(true);
    setError(null);
    setFormError(null);
    try {
      const response = await fetch('/api/candidates/manual', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...form,
          age: form.age === '' ? null : Number(form.age),
          experienceYears: form.experienceYears === '' ? null : Number(form.experienceYears),
          // One per line, as they are typed.
          qualifications: form.qualifications.split('\n').map((q) => q.trim()).filter(Boolean),
          domainExpertise: form.domainExpertise.split('\n').map((d) => d.trim()).filter(Boolean),
          skills: form.skills.split('\n').map((k) => k.trim()).filter(Boolean),
        }),
      });
      if (!response.ok) {
        throw await errorFrom(response);
      }
      const candidate = await response.json();
      // Straight to the profile: a hand-entered candidate is usually missing
      // something the person typing it already knows, and the detail page is
      // where they add it.
      navigate(`/talent/${candidate.external_id}`);
    } catch (e) {
      // Reported beside the button that was pressed, not in the page header.
      setFormError(e.message);
      setSaving(false);
    }
  }

  function field(key, label, props = {}) {
    return (
      <label className="block">
        <span className="micro">{label}</span>
        <input
          className="input mt-1.5 w-full"
          value={form[key]}
          onChange={(e) => setForm({ ...form, [key]: e.target.value })}
          {...props}
        />
      </label>
    );
  }

  return (
    <div className="space-y-10">
      <header className="flex flex-wrap items-end justify-between gap-4 border-b-2 border-ink pb-5">
        <div>
          <p className="micro">Managed here</p>
          <h1 className="page-title mt-1">Talent pool</h1>
          <p className="page-sub">
            Upload a CV and the fields are filled in for you, or enter someone by hand.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <a className="btn" href={`/api/candidates/export.csv?${params()}`}>
            Export CSV
          </a>
          <button
            className="btn"
            onClick={() => {
              setEntering((e) => !e);
              setUploadResult(null);
              setFormError(null);
            }}
          >
            {entering ? 'Cancel' : 'Add by hand'}
          </button>
          <button
            className="btn-solid"
            disabled={uploading}
            onClick={() => fileInput.current && fileInput.current.click()}
          >
            {uploading ? 'Reading CVs…' : 'Upload CVs'}
          </button>
          <input
            ref={fileInput}
            type="file"
            multiple
            accept=".pdf,.doc,.docx,.txt,.rtf,.md"
            className="hidden"
            onChange={onUpload}
          />
        </div>
      </header>

      {error && <div className="notice-error">{error}</div>}

      {entering && (
        <form onSubmit={createManual} className="panel space-y-5">
          <p className="text-sm text-ink-2">
            Only a name is required. Everything else can be filled in later from the
            candidate's profile.
          </p>

          <div className="grid gap-5 sm:grid-cols-2">
            {field('name', 'Name *', { required: true, placeholder: 'Priya Raman' })}
            {field('phone', 'Phone')}
            {field('email', 'Email', { type: 'email' })}
            {field('location', 'Location')}
            {field('currentDesignation', 'Current designation')}
            {field('currentCompany', 'Current company')}
            {field('experienceYears', 'Total experience (years)', {
              type: 'number', min: '0', step: '0.5',
            })}
            {field('age', 'Age', { type: 'number', min: '0', step: '1' })}
            {field('salaryText', 'Current salary', { placeholder: '24 LPA' })}
            <label className="block">
              <span className="micro">Employer listed</span>
              <select
                className="input mt-1.5 w-full"
                value={form.companyListingStatus}
                onChange={(e) => setForm({ ...form, companyListingStatus: e.target.value })}
              >
                <option value="">Not established</option>
                <option value="listed">Listed</option>
                <option value="unlisted">Unlisted</option>
              </select>
            </label>
            <label className="block">
              <span className="micro">Employee type</span>
              <select
                className="input mt-1.5 w-full"
                value={form.employeeType}
                onChange={(e) =>
                  setForm({
                    ...form,
                    employeeType: e.target.value,
                    // Cleared on the way out of non-elite rather than left
                    // sitting in state behind a hidden field. An elite
                    // candidate carries no referrer, and a name nobody can see
                    // any more must not be the one that gets saved.
                    referredBy: e.target.value === 'non_elite' ? form.referredBy : '',
                  })
                }
              >
                <option value="">Not set</option>
                {EMPLOYEE_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
            </label>
            {/* Only on the non-elite side. An elite candidate is here on their
                own record, so who referred them is a question with no answer —
                and the field is not merely disabled but absent, because an
                empty box still reads as something left unfilled. */}
            {form.employeeType === 'non_elite' &&
              field('referredBy', 'Referred by', { placeholder: 'Anil Kumar' })}
          </div>

          <div className="grid gap-5 sm:grid-cols-2">
            <label className="block">
              <span className="micro">Skills — one per line</span>
              <textarea
                className="input mt-1.5 h-24 w-full"
                value={form.skills}
                onChange={(e) => setForm({ ...form, skills: e.target.value })}
                placeholder={'IFRS\nTreasury management'}
              />
            </label>
            <label className="block">
              <span className="micro">Domain expertise — one per line</span>
              <textarea
                className="input mt-1.5 h-24 w-full"
                value={form.domainExpertise}
                onChange={(e) => setForm({ ...form, domainExpertise: e.target.value })}
                placeholder={'BFSI\nManufacturing'}
              />
            </label>
          </div>

          <label className="block">
            <span className="micro">Qualifications — one per line</span>
            <textarea
              className="input mt-1.5 h-24 w-full"
              value={form.qualifications}
              onChange={(e) => setForm({ ...form, qualifications: e.target.value })}
              placeholder={'B.Tech, Computer Science\nAWS Solutions Architect'}
            />
          </label>

          <label className="block">
            <span className="micro">First note — where they came from, what was said</span>
            <textarea
              className="input mt-1.5 h-24 w-full"
              value={form.note}
              onChange={(e) => setForm({ ...form, note: e.target.value })}
              placeholder="Referred by Anil. Open to relocating, notice period 30 days."
            />
          </label>

          {formError && (
            <div ref={formErrorRef} className="notice-error">
              {formError}
            </div>
          )}

          <button className="btn-solid" type="submit" disabled={saving}>
            {saving ? 'Saving…' : 'Add candidate'}
          </button>
        </form>
      )}

      {uploadResult && (
        <div className="callout space-y-2">
          <p>
            <strong>{uploadResult.stored}</strong> CV(s) added
            {uploadResult.failed > 0 && <>, <strong>{uploadResult.failed}</strong> could not be read</>}.
          </p>
          {(uploadResult.errors || []).map((e, i) => (
            <p key={i} className="text-xs text-ink-2">
              {e.file}: {e.error}
            </p>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-6 border border-rule bg-surface px-5 py-4">
        <label className="flex flex-1 items-center gap-2.5">
          <span className="micro">Search</span>
          <input
            className="input flex-1"
            placeholder="Name, company, designation, location…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <label className="flex items-center gap-2.5">
          <span className="micro">Min years</span>
          <input
            className="input w-20"
            type="number"
            min="0"
            step="0.5"
            value={minExperience}
            onChange={(e) => setMinExperience(e.target.value)}
          />
        </label>
        <label className="flex items-center gap-2.5">
          <span className="micro">Skill</span>
          <input
            className="input w-36"
            value={skill}
            onChange={(e) => setSkill(e.target.value)}
            placeholder="Kubernetes"
            title="Matches any one of a candidate's skills"
          />
        </label>
        <label className="flex items-center gap-2.5">
          <span className="micro">Domain</span>
          <input
            className="input w-36"
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            placeholder="BFSI"
            title="Matches any one of a candidate's sectors"
          />
        </label>
        {/* Typed the way salaries are written — "20 LPA", not 2000000 — and
            read with the same parser that reads the field it filters on, so
            the box and the column speak the same language. */}
        <label className="flex items-center gap-2.5">
          <span className="micro">Current salary</span>
          <input
            className="input w-28"
            value={salaryFrom}
            onChange={(e) => setSalaryFrom(e.target.value)}
            placeholder="from 15 LPA"
            title="Lowest current salary to include, e.g. 15 LPA"
          />
          <input
            className="input w-28"
            value={salaryTo}
            onChange={(e) => setSalaryTo(e.target.value)}
            placeholder="to 30 LPA"
            title="Highest current salary to include, e.g. 30 LPA"
          />
        </label>
        <label className="flex items-center gap-2.5">
          <span className="micro">Employer</span>
          <select
            className="input"
            value={listingStatus}
            onChange={(e) => setListingStatus(e.target.value)}
          >
            <option value="">Any</option>
            <option value="listed">Listed</option>
            <option value="unlisted">Unlisted</option>
          </select>
        </label>
        <label className="flex items-center gap-2.5">
          <span className="micro">Employee type</span>
          <select
            className="input"
            value={employeeType}
            onChange={(e) => setEmployeeType(e.target.value)}
            title="Elite, or non-elite — candidates nobody has classified are in neither"
          >
            <option value="">Any</option>
            {EMPLOYEE_TYPES.map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
        </label>
        <p className="tnum text-sm text-ink-2">{total} total</p>
      </div>

      {loading ? (
        <div className="space-y-2">
          {[...Array(5)].map((_, i) => <div key={i} className="skeleton h-12" />)}
        </div>
      ) : candidates.length === 0 ? (
        <div className="panel text-center">
          <p className="text-sm text-ink-2">
            Nobody here yet. Upload PDFs or Word documents, or add a candidate by hand.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                <th className="th">Name</th>
                {/* Beside the name rather than off in its own column: it is
                    what the type filter selects on, and a filter whose result
                    is invisible in the table is one nobody trusts. */}
                <th className="th">Type</th>
                <th className="th">Current role</th>
                <th className="th">Location</th>
                <th className="th">Experience</th>
                <th className="th">Current salary</th>
                {/* Skills are multi-word phrases — "Post Merger Integration",
                    "ERP implementation (Netsuite)". Left to the table's own
                    sizing this column collapsed to ~110px, where one skill took
                    three lines and five took eight. The table already scrolls
                    horizontally; the width is better spent here than saved. */}
                <th className="th min-w-[15rem]">Skills</th>
                <th className="th min-w-[9rem]">Domain</th>
                <th className="th">Contact</th>
                <th className="th">CV</th>
                <th className="th">Notes</th>
                {/* The column that turns the pool into a worklist: who has
                    been seen, how long ago, and whether anything is booked. */}
                <th className="th">Last met</th>
                <th className="th">Added</th>
              </tr>
            </thead>
            <tbody>
              {candidates.map((c) => (
                <tr
                  key={c.external_id}
                  className="row"
                  onClick={() => navigate(`/talent/${c.external_id}`)}
                >
                  <td className="td">
                    <span className="font-semibold">{c.name || '—'}</span>
                    <span className="mono block">{c.external_id}</span>
                  </td>
                  <td className="td text-xs">
                    {employeeTypeLabel(c.employee_type) || <span className="text-ink-3">—</span>}
                    {c.referred_by && (
                      <span className="block text-ink-2">via {c.referred_by}</span>
                    )}
                  </td>
                  <td className="td">
                    {c.current_designation || '—'}
                    {c.current_company && (
                      <span className="block text-xs text-ink-2">{c.current_company}</span>
                    )}
                  </td>
                  <td className="td">{c.location || '—'}</td>
                  <td className="td tnum">
                    {c.experience_years === null || c.experience_years === undefined
                      ? '—'
                      : `${c.experience_years} yr`}
                  </td>
                  <td className="td">
                    {c.salary_text || <span className="text-ink-3">—</span>}
                    {c.company_listing_status && (
                      <span className="block text-xs text-ink-2">
                        {c.company_listing_status === 'listed' ? 'Listed' : 'Unlisted'} employer
                      </span>
                    )}
                  </td>
                  {/* Folded, not shortened. A CV can name forty skills and all
                      of them are searchable; showing all of them turns one row
                      into a screenful. */}
                  <td className="td text-xs">
                    <TruncatedList items={c.skills} />
                  </td>
                  <td className="td text-xs">
                    <TruncatedList items={c.domain_expertise} />
                  </td>
                  <td className="td">
                    {c.email && <span className="block text-xs">{c.email}</span>}
                    {c.phone && <span className="block text-xs text-ink-2">{c.phone}</span>}
                    {!c.email && !c.phone && '—'}
                  </td>
                  {/* stopPropagation on each: the row navigates, and a click
                      meant for the document should open the document. */}
                  <td className="td whitespace-nowrap">
                    {c.has_file ? (
                      <span className="flex gap-3">
                        <a
                          className="btn-quiet text-xs"
                          href={`/api/candidates/${c.external_id}/file`}
                          target="_blank"
                          rel="noreferrer"
                          onClick={(e) => e.stopPropagation()}
                        >
                          View
                        </a>
                        <a
                          className="btn-quiet text-xs"
                          href={`/api/candidates/${c.external_id}/file?download=1`}
                          onClick={(e) => e.stopPropagation()}
                        >
                          Download
                        </a>
                      </span>
                    ) : c.entry_mode === 'manual' ? (
                      <span className="text-xs text-ink-3">By hand</span>
                    ) : (
                      // Uploaded before the file itself was kept. The extracted
                      // text is all there is, and offering it beats a profile
                      // with no way to read the CV at all.
                      <a
                        className="btn-quiet text-xs"
                        href={`/api/candidates/${c.external_id}/cv.txt`}
                        onClick={(e) => e.stopPropagation()}
                        title="The original file was not kept for this upload — this is the extracted text"
                      >
                        Text only
                      </a>
                    )}
                  </td>
                  <td className="td tnum text-xs text-ink-2">{c.note_count || '—'}</td>
                  <td className="td whitespace-nowrap text-xs">
                    {c.last_meeting_at ? (
                      <>
                        <span className="font-semibold text-ink">
                          {formatRelative(c.last_meeting_at)}
                        </span>
                        <span className="block text-ink-2">
                          {formatDate(c.last_meeting_at)}
                        </span>
                      </>
                    ) : (
                      <span className="text-ink-3">Never</span>
                    )}
                    {/* Only when something is arranged. A blank here means
                        nothing is booked, which is the state worth seeing on
                        somebody last met five months ago. */}
                    {c.next_meeting_at && (
                      <span className="mt-0.5 block text-ink-2">
                        next {formatRelative(c.next_meeting_at)}
                      </span>
                    )}
                  </td>
                  <td className="td text-xs text-ink-2">{formatDate(c.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
