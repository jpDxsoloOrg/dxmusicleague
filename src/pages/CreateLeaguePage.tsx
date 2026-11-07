import { useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { data } from "../data";
import { listProviderOptions } from "../music";
import type { MusicProviderId } from "../music";
import type { LeagueFormat, LeagueVisibility, RoundProgression } from "../domain/types";
import "./CreateLeaguePage.css";

/** Beta gate for timed rounds — flip to false to hide them from new leagues. */
const TIMED_ROUNDS_ENABLED = true;

/** Beta gate for head-to-head leagues — flip to false to hide the format
 *  picker (every new league is then "Points", and the create request is
 *  exactly what it was before formats existed). */
const H2H_ENABLED = true;

/** A head-to-head league doesn't ask for a round count: the server sets it to
 *  the round-robin length (everyone plays everyone once) when round 1 opens
 *  and freezes the field. Creation still needs a valid number, so this
 *  provisional one is sent and overwritten at the freeze. Until then
 *  `league.roundCount` is only this placeholder: a page showing an H2H
 *  league's round count before its round 1 leaves draft should say the
 *  schedule is set when round 1 opens instead (overview stepper and
 *  dashboard summary — HTH-11). */
const H2H_PROVISIONAL_ROUNDS = 3;

const FORMAT_OPTIONS: Array<{ id: LeagueFormat; title: string; blurb: string }> = [
  { id: "standard", title: "Points", blurb: "Everyone votes points on every song. Most points overall wins." },
  { id: "headToHead", title: "Head-to-Head", blurb: "1v1 matchups each round — most votes wins. W/L standings." },
];

/** Arrow key -> how far it moves the format selection (wrapping). */
const ARROW_STEP: Record<string, number | undefined> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

export function CreateLeaguePage() {
  const navigate = useNavigate();
  const providers = listProviderOptions();

  const [name, setName] = useState("");
  // Default to Spotify per the product decision (musicLeagueClone.md §8).
  const [provider, setProvider] = useState<MusicProviderId>("spotify");
  const [visibility, setVisibility] = useState<LeagueVisibility>("private");
  const [maxMembers, setMaxMembers] = useState(5);
  const [roundCount, setRoundCount] = useState(3);
  const [progression, setProgression] = useState<RoundProgression>("manual");
  const [startDate, setStartDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [phaseDays, setPhaseDays] = useState(3);
  const [format, setFormat] = useState<LeagueFormat>("standard");
  const formatRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isPublic = visibility === "public";
  const isTimed = progression === "timed";
  const isH2H = H2H_ENABLED && format === "headToHead";
  const capOk = !isPublic || (maxMembers >= 2 && maxMembers <= 50);
  // Head-to-head hides the rounds input, so its value can't block creation.
  const roundsOk = isH2H || (roundCount >= 1 && roundCount <= 20);
  const timingOk = !isTimed || (phaseDays >= 1 && phaseDays <= 30);
  const canCreate = name.trim().length >= 3 && capOk && roundsOk && timingOk && !busy;

  // The format cards follow the radio-group keyboard pattern: the group is one
  // tab stop (the checked card), and the arrow keys move the selection.
  function handleFormatKey(e: KeyboardEvent<HTMLButtonElement>, i: number) {
    const step = ARROW_STEP[e.key];
    if (!step) return;
    e.preventDefault();
    const next = (i + step + FORMAT_OPTIONS.length) % FORMAT_OPTIONS.length;
    setFormat(FORMAT_OPTIONS[next].id);
    formatRefs.current[next]?.focus();
  }

  async function handleCreate() {
    if (!canCreate) return;
    setBusy(true);
    setError(null);
    try {
      const league = await data.createLeague({
        name,
        musicProvider: provider,
        visibility,
        maxMembers: isPublic ? maxMembers : undefined,
        roundCount: isH2H ? H2H_PROVISIONAL_ROUNDS : roundCount,
        progression,
        startAt: isTimed && startDate ? new Date(startDate).toISOString() : undefined,
        phaseDays: isTimed ? phaseDays : undefined,
        // Only sent for head-to-head: a points league's request stays exactly
        // as it was (the server defaults an absent format to "standard").
        format: isH2H ? "headToHead" : undefined,
      });
      navigate(`/leagues/${league.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't create the league.");
      setBusy(false);
    }
  }

  return (
    <div className="create-league">
      <Link to="/" className="link-muted">← Back to dashboard</Link>

      <div className="create-card">
        <header className="create-head">
          <h1>Create a league</h1>
          <p>Start a new competition and invite your circle. You can set up the first round once it's created.</p>
        </header>

        <label className="field">
          <span className="field-label">League name</span>
          <input
            autoFocus
            className="field-input"
            placeholder="e.g. Friday Night Bangers"
            value={name}
            maxLength={50}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleCreate()}
          />
          <span className="field-hint">At least 3 characters.</span>
        </label>

        <label className="field">
          <span className="field-label">Music service</span>
          <select
            className="field-input"
            value={provider}
            onChange={(e) => setProvider(e.target.value as MusicProviderId)}
          >
            {providers.map((p) => (
              <option key={p.id} value={p.id} disabled={!p.available}>
                {p.name}{p.available ? "" : " — coming soon"}
              </option>
            ))}
          </select>
          <span className="field-hint">
            Players never log in to this service — they just open the public playlist you share each round.
          </span>
        </label>

        {H2H_ENABLED && (
          <div className="field">
            <span className="field-label" id="format-label">Format</span>
            <div className="format-options" role="radiogroup" aria-labelledby="format-label">
              {FORMAT_OPTIONS.map((opt, i) => (
                <button
                  key={opt.id}
                  ref={(el) => {
                    formatRefs.current[i] = el;
                  }}
                  type="button"
                  role="radio"
                  aria-checked={format === opt.id}
                  tabIndex={format === opt.id ? 0 : -1}
                  className={`format-option${format === opt.id ? " selected" : ""}`}
                  onClick={() => setFormat(opt.id)}
                  onKeyDown={(e) => handleFormatKey(e, i)}
                >
                  <span className="format-option-title">{opt.title}</span>
                  <span className="format-option-blurb">{opt.blurb}</span>
                </button>
              ))}
            </div>
            <span className="field-hint">
              {isH2H
                ? "Odd number of players? One sits out each round with an exhibition song. New players can join until round 1 opens."
                : "Set once, when the league is created — it can't be changed later."}
            </span>
          </div>
        )}

        {isH2H ? (
          <div className="field">
            <span className="field-label">Number of rounds</span>
            <p className="format-rounds-note">
              Rounds = everyone plays everyone once — set when round 1 opens.
            </p>
          </div>
        ) : (
          <label className="field">
            <span className="field-label">Number of rounds</span>
            <input
              className="field-input"
              type="number"
              min={1}
              max={20}
              value={roundCount}
              onChange={(e) => setRoundCount(Number(e.target.value))}
            />
            <span className="field-hint">How many rounds this league will run. Between 1 and 20 — you'll set each round's theme later.</span>
          </label>
        )}

        <label className="field">
          <span className="field-label">Round timing</span>
          <select
            className="field-input"
            value={progression}
            onChange={(e) => setProgression(e.target.value as RoundProgression)}
          >
            <option value="manual">Manual — you open each phase yourself</option>
            {TIMED_ROUNDS_ENABLED && (
              <option value="timed">Timed — phases auto-advance on a schedule</option>
            )}
          </select>
          <span className="field-hint">
            {isTimed
              ? "Once you open a round, submitting → listening → voting → results advance automatically."
              : "You control when submissions open, close, voting starts, and results reveal."}
          </span>
        </label>

        {isTimed && (
          <div className="timed-fields">
            <label className="field">
              <span className="field-label">League start</span>
              <input
                className="field-input"
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
              />
              <span className="field-hint">The first round's timer won't begin before this date.</span>
            </label>
            <label className="field">
              <span className="field-label">Days per phase</span>
              <input
                className="field-input"
                type="number"
                min={1}
                max={30}
                value={phaseDays}
                onChange={(e) => setPhaseDays(Number(e.target.value))}
              />
              <span className="field-hint">How long each phase lasts before it auto-advances (1–30 days).</span>
            </label>
          </div>
        )}

        <label className="field">
          <span className="field-label">Visibility</span>
          <select
            className="field-input"
            value={visibility}
            onChange={(e) => setVisibility(e.target.value as LeagueVisibility)}
          >
            <option value="private">Private — invite code only</option>
            <option value="public">Public — anyone can find and join</option>
          </select>
          <span className="field-hint">
            {isPublic
              ? "Your league appears in Discover so players can claim an open spot."
              : "Only people you share the invite code with can join."}
          </span>
        </label>

        {isPublic && (
          <label className="field">
            <span className="field-label">Max players</span>
            <input
              className="field-input"
              type="number"
              min={2}
              max={50}
              value={maxMembers}
              onChange={(e) => setMaxMembers(Number(e.target.value))}
            />
            <span className="field-hint">Sets the open slots players can claim. Between 2 and 50.</span>
          </label>
        )}

        {error && <span className="field-error">{error}</span>}

        <button className="btn btn-primary create-btn" disabled={!canCreate} onClick={handleCreate}>
          {busy ? "Creating…" : "Create league →"}
        </button>
      </div>
    </div>
  );
}
