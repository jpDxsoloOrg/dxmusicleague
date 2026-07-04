import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation } from "react-router-dom";
import { AuthProvider, useAuth } from "./auth/AuthContext";
import { AppLayout } from "./components/AppLayout";
import { DashboardPage } from "./pages/DashboardPage";
import { RoundOverviewPage } from "./pages/RoundOverviewPage";
import { SubmitSongPage } from "./pages/SubmitSongPage";
import { VotePage } from "./pages/VotePage";
import { RevealPage } from "./pages/RevealPage";
import { RoundsPage } from "./pages/RoundsPage";
import { LeaderboardPage } from "./pages/LeaderboardPage";
import { ProfilePage } from "./pages/ProfilePage";
import { HelpPage } from "./pages/HelpPage";
import { CreateLeaguePage } from "./pages/CreateLeaguePage";
import { LeagueSettingsPage } from "./pages/LeagueSettingsPage";
import { JoinLeaguePage } from "./pages/JoinLeaguePage";
import { PreviewLeaguePage } from "./pages/PreviewLeaguePage";
import { LeaguesPage } from "./pages/LeaguesPage";
import { Placeholder } from "./pages/Placeholder";
import { SignInPage } from "./pages/SignInPage";
import { SignUpPage } from "./pages/SignUpPage";
import { ConfirmEmailPage } from "./pages/ConfirmEmailPage";
import { ForgotPasswordPage } from "./pages/ForgotPasswordPage";

/** Gate for the authenticated app. Sends signed-out users to /signin,
 *  remembering where they were headed so sign-in can return them. */
function RequireAuth() {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <div className="auth-screen" />; // brief: session restore
  // Keep the query string (e.g. /leagues/join?code=XXXX) so invite links survive the round-trip.
  if (!user) return <Navigate to="/signin" replace state={{ from: location.pathname + location.search }} />;
  return <Outlet />;
}

/** Keeps signed-in users out of the auth screens. */
function RedirectIfAuthed() {
  const { user, loading } = useAuth();
  if (loading) return <div className="auth-screen" />;
  if (user) return <Navigate to="/" replace />;
  return <Outlet />;
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          {/* Public auth screens */}
          <Route element={<RedirectIfAuthed />}>
            <Route path="/signin" element={<SignInPage />} />
            <Route path="/signup" element={<SignUpPage />} />
            <Route path="/forgot" element={<ForgotPasswordPage />} />
          </Route>
          {/* /confirm needs the pending-signup state even before a session exists */}
          <Route path="/confirm" element={<ConfirmEmailPage />} />

          {/* Authenticated app */}
          <Route element={<RequireAuth />}>
            <Route element={<AppLayout />}>
              <Route index element={<DashboardPage />} />
              <Route path="/leagues/:leagueId" element={<RoundOverviewPage />} />
              <Route path="/leagues/:leagueId/submit" element={<SubmitSongPage />} />
              <Route path="/leagues/:leagueId/vote" element={<VotePage />} />
              <Route path="/leagues/:leagueId/reveal" element={<RevealPage />} />
              <Route path="/leagues/:leagueId/settings" element={<LeagueSettingsPage />} />
              <Route path="/leagues/new" element={<CreateLeaguePage />} />
              <Route path="/leagues/join" element={<JoinLeaguePage />} />
              <Route path="/leagues/:leagueId/preview" element={<PreviewLeaguePage />} />
              <Route path="/leagues" element={<LeaguesPage />} />
              <Route path="/rounds" element={<RoundsPage />} />
              <Route path="/leaderboard" element={<LeaderboardPage />} />
              <Route path="/profile" element={<ProfilePage />} />
              <Route path="/help" element={<HelpPage />} />
              <Route path="*" element={<Placeholder title="Not Found" />} />
            </Route>
          </Route>
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
