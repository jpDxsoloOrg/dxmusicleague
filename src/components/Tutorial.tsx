// Guided "how it works" walkthrough. Shown automatically on a user's first
// sign-in (AppLayout tracks that per user in localStorage) and replayable
// from the Help page.

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
    body: "It's a game of music discovery with friends. Each round everyone secretly submits a song, everyone listens, everyone votes — and the best picks score points.",
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
    body: "You get a pool of points to spread across the other players' songs. There's a cap on how many points one song can get, so you'll be rewarding a few favorites — and you can't vote for your own.",
  },
  {
    title: "Climb the leaderboard",
    body: "When votes are revealed, everyone sees who submitted what and how it scored. Points add up round after round — the most points when the final round ends wins the league.",
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
