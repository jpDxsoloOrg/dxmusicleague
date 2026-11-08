import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Tutorial } from "../components/Tutorial";
import "./HelpPage.css";

// Wiki-style help centre. The left rail is a table of contents with scroll-spy;
// the right column is the content. TOC entries and <Section> ids must stay in
// sync — the ids below are the single source of truth for both.
//
// Two league formats exist (HTH epic): "Points" (standard) and "Head-to-Head".
// The general sections describe the points game the way they always have and
// add a short head-to-head note where the format changes things; the full
// head-to-head rules live in one place, the "League formats" and
// "Head-to-head, in detail" sections, which the notes link to. Everything here
// describes shipped behavior only — never promise unbuilt features (playoffs).
const TOC: { group: string; items: { id: string; label: string }[] }[] = [
  {
    group: "The basics",
    items: [
      { id: "overview", label: "How the game works" },
      { id: "lifecycle", label: "A round, step by step" },
      { id: "formats", label: "League formats" },
      { id: "head-to-head", label: "Head-to-head, in detail" },
    ],
  },
  {
    group: "Getting started",
    items: [
      { id: "create", label: "Create a league" },
      { id: "join", label: "Join a league" },
      { id: "invite", label: "Invite people" },
    ],
  },
  {
    group: "Playing a round",
    items: [
      { id: "submit", label: "Submit a song" },
      { id: "listen", label: "Listen to the playlist" },
      { id: "vote", label: "Vote" },
      { id: "results", label: "Results & reveal" },
    ],
  },
  {
    group: "Standings",
    items: [
      { id: "leaderboard", label: "Leaderboards" },
      { id: "profile", label: "Your profile" },
    ],
  },
  {
    group: "Running a league",
    items: [
      { id: "owner-rounds", label: "Manage the rounds" },
      { id: "timing", label: "Manual vs timed" },
      { id: "settings", label: "League settings" },
    ],
  },
  {
    group: "Membership",
    items: [
      { id: "leave", label: "Leave a league" },
    ],
  },
  {
    group: "Reference",
    items: [
      { id: "glossary", label: "Glossary" },
      { id: "faq", label: "FAQ" },
    ],
  },
];

const ALL_IDS = TOC.flatMap((g) => g.items.map((i) => i.id));

export function HelpPage() {
  const [active, setActive] = useState<string>(ALL_IDS[0]);
  const [showTour, setShowTour] = useState(false);

  // Scroll-spy: highlight the TOC entry for whichever section is nearest the top.
  useEffect(() => {
    const sections = ALL_IDS.map((id) => document.getElementById(id)).filter(
      (el): el is HTMLElement => el !== null,
    );
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActive(visible[0].target.id);
      },
      // Bias the "active" band toward the top of the viewport.
      { rootMargin: "-96px 0px -60% 0px", threshold: 0 },
    );
    sections.forEach((s) => observer.observe(s));
    return () => observer.disconnect();
  }, []);

  return (
    <div className="help-page">
      <header className="help-hero">
        <span className="help-eyebrow grad-text">Help centre</span>
        <h1>How DX Music League works</h1>
        <p>
          A friendly guide to the whole game — from creating your first league to
          casting your votes. New here? Start with <a href="#overview">How the game works</a>.
        </p>
        <div className="help-hero-actions">
          <button type="button" className="btn btn-primary" onClick={() => setShowTour(true)}>
            Replay the guided tour
          </button>
        </div>
      </header>

      <div className="help-layout">
        {/* Table of contents */}
        <nav className="help-toc" aria-label="Help contents">
          {TOC.map((g) => (
            <div key={g.group} className="help-toc-group">
              <span className="help-toc-head">{g.group}</span>
              {g.items.map((i) => (
                <a
                  key={i.id}
                  href={`#${i.id}`}
                  className={`help-toc-link${active === i.id ? " active" : ""}`}
                >
                  {i.label}
                </a>
              ))}
            </div>
          ))}
        </nav>

        <div className="help-content">
          <Section id="overview" title="How the game works">
            <p>
              <strong>DX Music League</strong> is a game about sharing music and
              seeing whose taste wins the room. You play inside a{" "}
              <Term>league</Term> — a group of friends running a series of{" "}
              <Term>rounds</Term>. Each round works like a mini competition:
            </p>
            <ol className="help-flow">
              <li>The league <strong>owner</strong> announces a <Term>theme</Term> (for example, <em>“Songs that sound like summer”</em>).</li>
              <li>Every player <strong>submits one song</strong> that fits the theme.</li>
              <li>Once submissions close, all songs are collected into a <strong>playlist</strong> to listen to — with nobody's name attached.</li>
              <li>Players <strong>vote</strong> by spreading a pool of points across the songs they liked best.</li>
              <li>The round is <strong>revealed</strong>: submitters' names come out, points are tallied, and a winner is crowned.</li>
            </ol>
            <p>
              Points from every round add up on the league <Term>leaderboard</Term>,
              so there's an overall champion once all the rounds are done. That's the
              whole loop — <strong>submit → listen → vote → reveal</strong>, repeated
              for however many rounds the league runs.
            </p>
            <p>
              That's the classic <strong>Points</strong> format. Some leagues play{" "}
              <strong>Head-to-Head</strong> instead: the same loop, but each round your
              song goes 1v1 against another player's, everyone else picks the winner,
              and the league is ranked by win–loss record. See{" "}
              <a href="#formats">League formats</a>.
            </p>
            <Callout kind="tip" title="The golden rule">
              Voting is anonymous. You never see who submitted a song until the round
              is revealed, so you vote on the music, not on your friends.
            </Callout>
          </Section>

          <Section id="lifecycle" title="A round, step by step">
            <p>
              Every round moves through the same phases in order. You'll see the
              current phase as a coloured <Term>status pill</Term> on the league and
              on your Rounds page.
            </p>
            <div className="phase-track">
              <Phase pill="draft" name="Draft">
                The round exists but hasn't started. Players wait for the owner to
                open it.
              </Phase>
              <Phase pill="submitting" name="Submitting">
                Submissions are open. Every player picks and submits one song. You can
                change your pick right up until it closes.
              </Phase>
              <Phase pill="previewing" name="Listening">
                Submissions are closed and the songs are revealed as an anonymous
                playlist. Give everything a listen — voting hasn't opened yet.
              </Phase>
              <Phase pill="voting" name="Voting">
                Spend your points across the songs you liked best — or, in a
                head-to-head league, pick the winner of each matchup. Submitters are
                still hidden.
              </Phase>
              <Phase pill="revealed" name="Revealed">
                Voting is closed. Names are revealed, the votes are counted, the
                results are announced, and the leaderboard updates.
              </Phase>
            </div>
            <p className="help-note">
              A league runs a fixed number of rounds. When the final round is
              revealed it's marked <Term>Complete</Term>, and the leaderboard shows
              the overall champion.
            </p>
          </Section>

          <Section id="formats" title="League formats">
            <p>
              Every league plays one of two formats, chosen by the owner when the
              league is created — it can't be changed afterwards. Rounds run the same
              way in both (theme, submit, listen, vote, reveal); what differs is how
              you vote and how the league is scored.
            </p>
            <div className="format-compare">
              <div className="format-card">
                <h3>Points</h3>
                <ul className="help-list">
                  <li>You spread a <strong>pool of points</strong> across the other players' songs.</li>
                  <li>Each round's songs are <strong>ranked by points</strong>; the top song wins the round.</li>
                  <li>Points add up — <strong>most points overall</strong> wins the league.</li>
                  <li>The owner tunes the rules: pool size, cap per song, anti-votes, songs per player.</li>
                </ul>
              </div>
              <div className="format-card">
                <h3>Head-to-Head</h3>
                <ul className="help-list">
                  <li>Each round your song goes <strong>1v1</strong> against one other player's song.</li>
                  <li>Everyone else <strong>picks a winner</strong> in each matchup — most votes wins it.</li>
                  <li>Each matchup ends in a <strong>win, loss or draw</strong> (or a no contest if neither song is in); the league is ranked by record.</li>
                  <li>One song per player, no anti-votes, and <strong>everyone plays everyone once</strong>.</li>
                </ul>
              </div>
            </div>
            <p className="help-note">
              Not sure which you're in? Head-to-head leagues you've joined carry an{" "}
              <strong>H2H</strong> tag on their card under Your Leagues, and their
              leaderboard shows records (like <code>3–1</code>) instead of points.
            </p>
          </Section>

          <Section id="head-to-head" title="Head-to-head, in detail">
            <h3>How matchups are made</h3>
            <p>
              When the owner opens round 1, the players in the league are shuffled
              into a <Term>round-robin</Term> schedule: over the season,{" "}
              <strong>everyone plays everyone else exactly once</strong>. The schedule is
              random and fixed for the whole season, and it also sets how many rounds
              there are — one fewer than the number of players when that's even
              (6 players → 5 rounds), or one per player when it's odd (5 players → 5
              rounds).
            </p>
            <p>
              You don't find out who you're up against until the reveal. On the ballot
              your own matchup is marked so you know which one it is, but the other
              song in it stays anonymous, like every song.
            </p>

            <h3>Byes</h3>
            <p>
              Odd number of players? <strong>One person sits out each round</strong>{" "}
              — that's the <Term>bye</Term>, and over a season everyone gets it exactly
              once. The player with the bye still submits a song, as an{" "}
              <Term>exhibition</Term>: it's on the ballot and in the results, and it
              takes comments, but nobody votes on it and it doesn't count toward
              anyone's record. They still vote, too — in every matchup that round.
            </p>

            <h3>Voting: pick the winners</h3>
            <ul className="help-list">
              <li>Each matchup puts two anonymous songs head to head — tap the one you want to win.</li>
              <li>You pick in <strong>every matchup except your own</strong>. Yours is locked: the others decide it.</li>
              <li>You need a pick in every matchup you can vote in before you can submit; the counter shows how many are left.</li>
              <li>Comments work as in a points league, and you can change your picks until voting closes.</li>
            </ul>

            <h3>Wins, losses and draws</h3>
            <ul className="help-list">
              <li>The song with <strong>more votes wins</strong> the matchup: its player gets a win (W), the other player a loss (L).</li>
              <li>
                <strong>Equal votes is a draw</strong> (D) for both — 1–1, 2–2, even 0–0.
                Nothing breaks a tie: no coin flip, no tiebreaker.
              </li>
              <li>The reveal shows every matchup with both players' names, their songs, the votes each got, and the result.</li>
            </ul>

            <h3>If you don't submit</h3>
            <ul className="help-list">
              <li>
                Miss the deadline and you lose your matchup by <Term>walkover</Term>:
                your opponent takes the win without a vote, and you take the loss.
              </li>
              <li>If neither of you submits, it's a <Term>no contest</Term> — no result for either of you.</li>
              <li>A matchup that's missing a song takes no votes, so you won't be asked to pick in it.</li>
              <li>If the player with the bye doesn't submit, nothing changes — the bye isn't scored.</li>
            </ul>

            <h3>Standings</h3>
            <p>
              The leaderboard ranks by record: <strong>most wins first, then fewest
              losses</strong>. Records read wins–losses, like <code>3–1</code>; once
              anyone in the league has a draw, every record shows draws as well, like{" "}
              <code>3–1–1</code>. Draws count on your record but don't decide places,
              and players level on wins and losses are listed alphabetically. Whoever's
              on top when the last round is revealed wins the league.
            </p>

            <h3>Joining, leaving and the season lock</h3>
            <ul className="help-list">
              <li>Players can join until round 1 opens — with the invite code, or by claiming a spot if the league is public.</li>
              <li>
                <strong>Opening round 1 locks the season.</strong> The schedule is drawn
                from the players already in, so nobody new can join after that — not
                even with the invite code.
              </li>
              <li>
                Players in the season can leave and come back with the invite code.
                While someone's out, their matchups go to their opponents as
                walkovers — but they don't take the losses, and their record is
                still there when they return.
              </li>
            </ul>
            <Callout kind="note" title="When a round skips voting">
              If nobody has a matchup to vote in, the round skips voting and goes
              straight from listening to the results. That's always the case in a
              two-player league — the only matchup is both players' own, so with both
              songs in it ends as a 0–0 draw — and it also happens when every matchup
              is missing a song.
            </Callout>
          </Section>

          <Section id="create" title="Create a league">
            <p>
              From <NavRef>Home</NavRef> or <NavRef>Leagues</NavRef>, click{" "}
              <strong>Create league</strong> (or go straight to{" "}
              <Link to="/leagues/new">/leagues/new</Link>). You'll be the league{" "}
              <strong>owner</strong>. Fill in:
            </p>
            <dl className="help-defs">
              <dt>League name</dt>
              <dd>At least 3 characters — e.g. <em>Friday Night Bangers</em>.</dd>
              <dt>Music service</dt>
              <dd>
                Which service the shared playlists live on. Players never have to log
                in to it — they just open the public playlist you share each round.
              </dd>
              <dt>Format</dt>
              <dd>
                <strong>Points</strong> or <strong>Head-to-Head</strong> — see{" "}
                <a href="#formats">League formats</a>. You can't change it once the
                league exists.
              </dd>
              <dt>Number of rounds</dt>
              <dd>
                How many rounds the league will run, from 1 to 20. You set each round's
                theme later. Head-to-head leagues don't ask: everyone plays everyone
                once, so the number of rounds is set when round 1 opens.
              </dd>
              <dt>Round timing</dt>
              <dd>
                <strong>Manual</strong> — you open each phase yourself. <strong>Timed</strong> — phases
                auto-advance on a schedule. See <a href="#timing">Manual vs timed</a>.
              </dd>
              <dt>Visibility</dt>
              <dd>
                <strong>Private</strong> — joinable only with the invite code, no member limit.{" "}
                <strong>Public</strong> — appears in Trending for anyone to find and claim a spot (you set a max number of players).
              </dd>
            </dl>
            <p>
              Hit <strong>Create league</strong> and you'll land on the league's home
              page, ready to invite people and set up round one.
            </p>
          </Section>

          <Section id="join" title="Join a league">
            <p>There are two ways in, depending on how the league was set up.</p>
            <h3>With an invite code</h3>
            <p>
              Go to <NavRef>Home</NavRef> → <strong>Join a league</strong> (or{" "}
              <Link to="/leagues/join">/leagues/join</Link>) and enter the code a
              friend shared with you. Codes aren't case-sensitive. If someone sent you
              a full invite link, clicking it drops the code in for you automatically —
              you may just need to sign in first.
            </p>
            <h3>By discovering a public league</h3>
            <p>
              Public leagues show up in the <strong>Trending Leagues</strong> section
              on your Home page. Click one to open its <strong>preview</strong>, where
              you can see the theme, how many players have joined, and how many slots
              are open. A head-to-head league carries an <strong>H2H</strong> tag on its
              card and preview, and the preview sums up how it plays. If there's room,
              hit <strong>Claim a spot</strong> to join — you can still hop in while
              round 1 is accepting submissions.
            </p>
            <Callout kind="note" title="If a league is full or underway">
              You can't claim a spot once a public league hits its player cap or once
              round 1 has closed submissions. Ask the owner whether they can make room.
              Head-to-head leagues close sooner: once round 1 opens, the season is
              locked and nobody new can join, even with an invite code (see{" "}
              <a href="#head-to-head">Head-to-head, in detail</a>).
            </Callout>
          </Section>

          <Section id="invite" title="Invite people">
            <p>
              Open your league's home page. Near the top you'll find the{" "}
              <strong>Invite</strong> panel showing the league's <Term>invite code</Term>.
              Any member can invite others — not just the owner. You get two buttons:
            </p>
            <ul className="help-list">
              <li><strong>Copy code</strong> — copies just the code (e.g. <code>SYNTH-23</code>) to paste into a chat.</li>
              <li><strong>Copy invite link</strong> — copies a ready-to-send link that opens the join screen with the code already filled in.</li>
            </ul>
            <p className="help-note">
              For public leagues, the invite panel disappears once every slot is
              filled.
            </p>
          </Section>

          <Section id="submit" title="Submit a song">
            <p>
              When a round is <StatusPill pill="submitting">Submitting</StatusPill>,
              open the league and click <strong>Submit your song</strong>, or use the{" "}
              <strong>Submit song</strong> button on your <NavRef>Rounds</NavRef> page.
            </p>
            <ol className="help-steps">
              <li>Read the round's <Term>theme</Term> at the top of the page.</li>
              <li>Search for a track by title or artist. Results appear as you type.</li>
              <li>Hit <strong>Select</strong> on the one you want — it moves into the “Your submission” panel, where you can hear a preview clip if one's available.</li>
              <li>Optionally add a <strong>comment</strong> explaining your pick. It stays hidden until the round is revealed.</li>
              <li>Click <strong>Submit song</strong>. You'll get a confirmation, and your pick is locked in.</li>
            </ol>
            <Callout kind="tip" title="Changed your mind?">
              You can change your submission any time while the round is still in the
              Submitting phase — just come back and pick a different track.
            </Callout>
          </Section>

          <Section id="listen" title="Listen to the playlist">
            <p>
              Once submissions close, the round moves to the{" "}
              <StatusPill pill="previewing">Listening</StatusPill> phase. All the
              songs are gathered into a single playlist — with no names attached — so
              you can listen before you vote.
            </p>
            <p>
              On the league page you'll see an <strong>Open playlist</strong> button
              that opens the playlist in the league's music service. Voting isn't open
              yet; this phase is purely for giving everything a fair listen.
            </p>
          </Section>

          <Section id="vote" title="Vote">
            <p>
              When the round reaches <StatusPill pill="voting">Voting</StatusPill>,
              open it and click <strong>Vote now</strong>. Voting is how songs earn
              points.
            </p>
            <h3>How points work</h3>
            <ul className="help-list">
              <li>You get a <strong>pool of points</strong> to spend (10 by default).</li>
              <li>Use the <strong>−</strong> and <strong>+</strong> steppers to place points on the songs you liked.</li>
              <li>There's a <strong>cap per song</strong> (5 by default) so you have to spread your points around rather than dumping them all on one favourite.</li>
              <li>You must spend <strong>every point</strong> in your pool before you can submit — or, when the songs on offer can't take that many (say, just one other song in a two-player league), as many as they can take. The counter shows how many you have left.</li>
              <li>You can add an optional <strong>comment</strong> to any song; it's shown next to that song when the round is revealed.</li>
              <li>Some leagues also give you <strong>anti-votes</strong> (💔): each subtracts a point from a song. Spending them is optional, and totals can go negative.</li>
            </ul>
            <p>
              Submitters stay anonymous the whole time. Hit <strong>Submit votes</strong>{" "}
              once your pool is empty. The exact pool size, per-song cap, and whether
              you're allowed to vote for your own song are set by the owner in{" "}
              <a href="#settings">league settings</a>.
            </p>
            <h3>In a head-to-head league</h3>
            <p>
              The button reads <strong>Pick your winners</strong>, and there's no
              points pool. The page shows the round's{" "}
              <strong>matchups</strong>, two anonymous songs each — tap a song to pick
              it as the winner, in every matchup except your own (it's locked: the
              others decide it). A matchup missing a song has nothing to pick, and the
              bye player's song shows as an <strong>exhibition</strong>. Once every
              matchup you can vote in has a pick, hit <strong>Submit picks</strong>.
              More in <a href="#head-to-head">Head-to-head, in detail</a>.
            </p>
          </Section>

          <Section id="results" title="Results & reveal">
            <p>
              After voting closes the round is <StatusPill pill="revealed">Revealed</StatusPill>.
              Open <strong>View results</strong> to see:
            </p>
            <ul className="help-list">
              <li>The <strong>winning song</strong> 🏆 with its point total and who submitted it.</li>
              <li>Every other song <strong>ranked by points</strong>, each with its submitter revealed.</li>
              <li>Any <strong>voter comments</strong> shown beside the songs they were left on.</li>
              <li>A link to open the full round <strong>playlist</strong>.</li>
              <li>The updated <strong>overall leaderboard</strong> for the league.</li>
            </ul>
            <p>
              In a head-to-head league the results are a list of{" "}
              <strong>matchups</strong> instead: both songs with who submitted them, the
              votes each got, and who won — with a badge for a{" "}
              <strong>draw</strong>, a <strong>walkover</strong>, or a{" "}
              <strong>no contest</strong> — plus the bye player's exhibition song, which
              isn't scored.
            </p>
            <p className="help-note">
              This is the only moment names come out. Everything you submitted or
              commented is now visible to the whole league.
            </p>
          </Section>

          <Section id="leaderboard" title="Leaderboards">
            <p>
              Points from every revealed round add up. You'll see standings in a few
              places:
            </p>
            <ul className="help-list">
              <li>On the <NavRef>Leaderboard</NavRef> page — pick a league to see its full ranked standings, with your own row highlighted.</li>
              <li>In a sidebar on each league's home page and results page, showing the current top players.</li>
              <li>The top three are highlighted so you can see who's leading at a glance.</li>
            </ul>
            <p className="help-note">
              Head-to-head leagues show a <strong>Record</strong> column (wins–losses,
              plus draws once anyone has one) in place of points, ranked most wins
              first, then fewest losses.
            </p>
          </Section>

          <Section id="profile" title="Your profile">
            <p>
              The <NavRef>Profile</NavRef> page is your personal home. It shows your
              display name and a summary of how you're doing — how many leagues you're
              in, your total points, and your best finish — along with your rank in
              each league you belong to. Head-to-head leagues score no points, so for
              those it shows your record instead.
            </p>
          </Section>

          <Section id="owner-rounds" title="Manage the rounds (owners)">
            <p>
              If you created the league, you'll see an <strong>Owner controls</strong>{" "}
              panel on the league page. This is where you drive each round through its
              phases. In a <a href="#timing">manual</a> league you press each button
              yourself:
            </p>
            <ol className="help-steps">
              <li><strong>Create round</strong> — type the theme for the next round to create it as a <StatusPill pill="draft">Draft</StatusPill>.</li>
              <li><strong>Open for submissions</strong> — moves it to <StatusPill pill="submitting">Submitting</StatusPill> so players can add songs.</li>
              <li><strong>Close submissions &amp; reveal songs</strong> — moves it to <StatusPill pill="previewing">Listening</StatusPill> and builds the playlist.</li>
              <li><strong>Open voting</strong> — moves it to <StatusPill pill="voting">Voting</StatusPill>.</li>
              <li><strong>Close voting &amp; reveal results</strong> — tallies the votes and reveals everything.</li>
            </ol>
            <p>
              After a round is revealed, the panel offers to create the next one — up
              to the total number of rounds you chose when creating the league.
            </p>
            <h3>Running a head-to-head league</h3>
            <ul className="help-list">
              <li>
                Gather your players first: <strong>opening round 1</strong> draws the
                season's schedule, sets the number of rounds, and closes the league to
                new players. It needs at least 2 players.
              </li>
              <li>The schedule decides how many rounds there are, so the panel stops offering new rounds once everyone has played everyone.</li>
              <li>
                If nobody has a matchup to vote in, opening voting reveals the round
                straight away (see <a href="#head-to-head">Head-to-head, in detail</a>).
              </li>
            </ul>
            <Callout kind="note" title="Owners play too">
              Being the owner doesn't take you out of the game — you still submit songs
              and vote in every round like everyone else.
            </Callout>
          </Section>

          <Section id="timing" title="Manual vs timed rounds">
            <p>You choose how rounds advance when you create the league:</p>
            <dl className="help-defs">
              <dt>Manual</dt>
              <dd>
                Nothing moves until you press the button. Best when your group is small
                or you want to wait for everyone before moving on.
              </dd>
              <dt>Timed</dt>
              <dd>
                Each phase lasts a set number of days and then auto-advances:
                submitting → listening → voting → results, all on schedule. You still
                choose when the league starts and can <strong>move a phase on early</strong>{" "}
                yourself — and a phase also advances automatically once everyone has
                finished it.
              </dd>
            </dl>
          </Section>

          <Section id="settings" title="League settings (owners)">
            <p>
              Owners get a <strong>⚙ Settings</strong> link on the league page. From
              there you can adjust the voting rules:
            </p>
            <dl className="help-defs">
              <dt>Points to spend</dt>
              <dd>The size of each voter's point pool per round.</dd>
              <dt>Max points per song</dt>
              <dd>The most points a voter can place on any single song.</dd>
              <dt>Allow self-voting</dt>
              <dd>Whether players may put points on their own submission.</dd>
              <dt>Songs per player</dt>
              <dd>How many songs each player submits per round (1–5). Handy for small leagues.</dd>
              <dt>Anti-votes per player</dt>
              <dd>Optional negative votes (0–2). Each subtracts a point from a song at reveal; scores can go negative.</dd>
            </dl>
            <p>
              A head-to-head league has none of these to change: it's fixed at one song
              per player and no anti-votes, and voting is picking winners, so there's
              no points pool. Its settings page shows the format and those fixed rules
              instead.
            </p>
            <Callout kind="warn" title="Deleting a league">
              The settings page also has a <strong>delete league</strong> option. It's
              permanent and removes the league for everyone, so it asks you to confirm.
            </Callout>
          </Section>

          <Section id="leave" title="Leave a league">
            <p>
              Not feeling it? On the league page, members see a{" "}
              <strong>Leave league</strong> button (owners see Settings instead).
              Confirm and you'll be removed from the league. You can always rejoin
              later with the invite code, or by claiming a spot again if it's public.
            </p>
            <p>
              In a head-to-head league that's underway, your matchups go to your
              opponents as walkovers while you're gone — you don't take the losses —
              and you can rejoin with the invite code even though the season is locked
              to newcomers. Your record picks up where you left off.
            </p>
          </Section>

          <Section id="glossary" title="Glossary">
            <dl className="help-defs glossary">
              <dt>League</dt>
              <dd>A group of players running a series of rounds together. Private (invite-only) or public (discoverable).</dd>
              <dt>Round</dt>
              <dd>One cycle of the game: a theme, submissions, listening, voting, and a reveal.</dd>
              <dt>Theme</dt>
              <dd>The prompt or constraint for a round that submissions should fit.</dd>
              <dt>Submission</dt>
              <dd>The one song a player picks for a round, optionally with a comment.</dd>
              <dt>Owner</dt>
              <dd>The player who created the league. Controls rounds and settings; still plays.</dd>
              <dt>Invite code</dt>
              <dd>A short shareable code (e.g. <code>SYNTH-23</code>) that lets someone join a league.</dd>
              <dt>Point pool</dt>
              <dd>The points each voter spreads across songs when voting.</dd>
              <dt>Reveal</dt>
              <dd>The end of a round, when names come out, votes are tallied, and the results are announced.</dd>
              <dt>Leaderboard</dt>
              <dd>The running total of points across all revealed rounds in a league — or, in a head-to-head league, everyone's record.</dd>
              <dt>Format</dt>
              <dd>How a league is scored: <strong>Points</strong> or <strong>Head-to-Head</strong>. Chosen when the league is created.</dd>
              <dt>Matchup</dt>
              <dd>Head-to-head: two players' songs facing off in a round. Most votes wins.</dd>
              <dt>Record</dt>
              <dd>Head-to-head: a player's wins–losses (and draws), e.g. <code>3–1</code>.</dd>
              <dt>Draw</dt>
              <dd>Head-to-head: a matchup that ends level on votes. Both players get a D.</dd>
              <dt>Walkover</dt>
              <dd>Head-to-head: a matchup with only one song in. Its player wins without a vote; the other player takes the loss, unless they've left the league.</dd>
              <dt>No contest</dt>
              <dd>Head-to-head: a matchup with neither song in. No result for either.</dd>
              <dt>Bye</dt>
              <dd>Head-to-head, odd number of players: the player who sits out a round. Their song plays as an unscored exhibition.</dd>
              <dt>Season lock</dt>
              <dd>Head-to-head: once round 1 opens, the league takes no new players. Players already in it can still rejoin.</dd>
            </dl>
          </Section>

          <Section id="faq" title="FAQ">
            <div className="help-faq">
              <details>
                <summary>Do I need a Spotify or music-service account?</summary>
                <p>No. You pick songs through the app's search, and the shared playlist is public — you just open the link to listen.</p>
              </details>
              <details>
                <summary>Can I change my song or votes after submitting?</summary>
                <p>Yes, as long as that phase is still open. You can swap your submission during Submitting and adjust your votes during Voting, right up until the phase closes.</p>
              </details>
              <details>
                <summary>Will people know what I voted for?</summary>
                <p>Your points (or head-to-head picks) are anonymous, but any comment you attach to a song is shown next to it at reveal, along with your name. Submitters are hidden until the reveal too.</p>
              </details>
              <details>
                <summary>Why can't I submit my votes?</summary>
                <p>You have to spend all your points first: your entire point pool, or as many as the songs on offer can take when that's fewer. Check the “points left” counter — it has to reach zero. In a head-to-head league, you need a pick in every matchup you can vote in; the “picks left” counter has to reach zero.</p>
              </details>
              <details>
                <summary>Who am I up against in a head-to-head round?</summary>
                <p>You find out at the reveal. While voting is open your matchup is marked as yours, but the other song is anonymous like every other. Over the season you'll face everyone in the league once.</p>
              </details>
              <details>
                <summary>What happens if a head-to-head matchup is tied?</summary>
                <p>It's a draw — both players get a D on their record. There's no tiebreaker.</p>
              </details>
              <details>
                <summary>What if I miss a head-to-head deadline?</summary>
                <p>If you don't submit a song, you lose that round's matchup by walkover and your opponent gets the win (if your opponent didn't submit either, it's a no contest). If you have the bye that round, nothing happens — the bye isn't scored.</p>
              </details>
              <details>
                <summary>Why can't I join this head-to-head league?</summary>
                <p>Its season is locked: the schedule was drawn from the players who were in when round 1 opened, so it can't take anyone new. Players who were already in it can still rejoin.</p>
              </details>
              <details>
                <summary>Who can start rounds?</summary>
                <p>Only the league owner opens and advances rounds. In a timed league they advance on a schedule, but the owner can still nudge them along.</p>
              </details>
              <details>
                <summary>Can I be in more than one league?</summary>
                <p>Absolutely. Your Home, Rounds, and Leaderboard pages pull together everything across all the leagues you're in.</p>
              </details>
            </div>
          </Section>

          <footer className="help-foot">
            <p>Still stuck? Head <Link to="/">back to your dashboard</Link> and jump into a round — the best way to learn is to play. 🎧</p>
          </footer>
        </div>
      </div>

      {showTour && <Tutorial onClose={() => setShowTour(false)} />}
    </div>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className="help-section">
      <h2>
        <a href={`#${id}`} className="help-anchor" aria-label={`Link to ${title}`}>#</a>
        {title}
      </h2>
      {children}
    </section>
  );
}

function Callout({
  kind,
  title,
  children,
}: {
  kind: "tip" | "note" | "warn";
  title: string;
  children: ReactNode;
}) {
  const icon = kind === "tip" ? "💡" : kind === "warn" ? "⚠️" : "ℹ️";
  return (
    <div className={`help-callout help-callout-${kind}`}>
      <span className="help-callout-icon" aria-hidden>{icon}</span>
      <div>
        <strong>{title}</strong>
        <div>{children}</div>
      </div>
    </div>
  );
}

function Phase({ pill, name, children }: { pill: string; name: string; children: ReactNode }) {
  return (
    <div className="phase-item">
      <span className={`pill pill-${pill}`}>{name}</span>
      <p>{children}</p>
    </div>
  );
}

/** Inline reference to a term, styled subtly. */
function Term({ children }: { children: ReactNode }) {
  return <span className="help-term">{children}</span>;
}

/** Inline reference to a sidebar nav item. */
function NavRef({ children }: { children: ReactNode }) {
  return <span className="help-navref">{children}</span>;
}

/** Inline status pill used within body copy. */
function StatusPill({ pill, children }: { pill: string; children: ReactNode }) {
  return <span className={`pill pill-${pill} help-inline-pill`}>{children}</span>;
}
