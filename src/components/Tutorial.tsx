// Guided "how it works" walkthrough. Shown automatically on a user's first
// sign-in (AppLayout tracks that per user in localStorage) and replayable
// from the Help page.
//
// Neither trigger runs inside a league, so the tour can't know which format
// the player will meet: the steps that differ by format (scoring, voting,
// standings) describe both — Points and Head-to-Head — and point to Help's
// "League formats" section for the detail. Keep them neutral rather than
// assuming points.

import { useEffect, useState } from "react";
import "./Tutorial.css";

interface TutorialStep {
  title: string;
  body: string;
  hint?: string;
}

const TUTORIAL_STEPS: TutorialStep[] = [
  {
    title: "Welcome to Music League",
    body: "It's a game of music discovery with friends. Each round everyone secretly submits a song, everyone listens, everyone votes — and the best picks win.",
    hint: "This tour takes about a minute. You can replay it any time from Help in the sidebar.",
  },
  {
    title: "Join or create a league",
    body: "Go to Leagues to get started. Got an invite code from a friend? Enter it to join their league. Or create your own league and share your code with the group.",
    hint: "A league is your group of players plus a set number of rounds.",
  },
  {
    title: "Submit a song",
    body: "Every round has a theme — like “best road-trip track”. Search for one song that fits and submit it before the deadline. Nobody sees who picked what until the results.",
    hint: "You get one submission per round, so make it count.",
  },
  {
    title: "Listen to the playlist",
    body: "When submissions close, all the round's songs are collected into a playlist. Take some time to listen through before voting opens.",
  },
  {
    title: "Vote for your favorites",
    body: "It depends on the format. In a Points league, spread a pool of points over the songs you like, with a cap per song. In Head-to-Head, songs meet 1v1: pick the winner of every matchup but your own.",
    hint: "More in Help → League formats.",
  },
  {
    title: "Climb the leaderboard",
    body: "At the reveal, everyone sees who submitted what and how it did. Points leagues add up points; Head-to-Head leagues keep a win–loss record. Top of the table at the end wins.",
    hint: "That's it. Join a league and play your first round!",
  },
];

export function Tutorial({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState(0);
  const current = TUTORIAL_STEPS[step];
  const isLast = step === TUTORIAL_STEPS.length - 1;

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
      if (event.key === "ArrowRight") setStep((s) => Math.min(s + 1, TUTORIAL_STEPS.length - 1));
      if (event.key === "ArrowLeft") setStep((s) => Math.max(s - 1, 0));
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className="tutorial-overlay" onClick={onClose}>
      <div
        className="tutorial-card"
        role="dialog"
        aria-modal="true"
        aria-label="How Music League works"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="tutorial-step-count">
          Step {step + 1} of {TUTORIAL_STEPS.length}
        </div>

        <div className="tutorial-badge">
          <span className="grad-text">{step + 1}</span>
        </div>
        <h2 className="tutorial-title">{current.title}</h2>
        <p className="tutorial-body">{current.body}</p>
        {current.hint && <p className="tutorial-hint">{current.hint}</p>}

        <div className="tutorial-dots" aria-hidden>
          {TUTORIAL_STEPS.map((_, index) => (
            <button
              key={index}
              type="button"
              className={`tutorial-dot${index === step ? " active" : ""}`}
              onClick={() => setStep(index)}
              tabIndex={-1}
            />
          ))}
        </div>

        <div className="tutorial-actions">
          {step > 0 ? (
            <button type="button" className="btn" onClick={() => setStep(step - 1)}>
              Back
            </button>
          ) : (
            <button type="button" className="tutorial-skip" onClick={onClose}>
              Skip tour
            </button>
          )}
          {isLast ? (
            <button type="button" className="btn btn-primary" onClick={onClose}>
              Let's play
            </button>
          ) : (
            <button type="button" className="btn btn-primary" onClick={() => setStep(step + 1)}>
              Next
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
