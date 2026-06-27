import { BrowserRouter, Route, Routes } from "react-router-dom";
import { AppLayout } from "./components/AppLayout";
import { DashboardPage } from "./pages/DashboardPage";
import { RoundOverviewPage } from "./pages/RoundOverviewPage";
import { SubmitSongPage } from "./pages/SubmitSongPage";
import { VotePage } from "./pages/VotePage";
import { RevealPage } from "./pages/RevealPage";
import { RoundsPage } from "./pages/RoundsPage";
import { LeaderboardPage } from "./pages/LeaderboardPage";
import { ProfilePage } from "./pages/ProfilePage";
import { Placeholder } from "./pages/Placeholder";

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<AppLayout />}>
          <Route index element={<DashboardPage />} />
          <Route path="/leagues/:leagueId" element={<RoundOverviewPage />} />
          <Route path="/leagues/:leagueId/submit" element={<SubmitSongPage />} />
          <Route path="/leagues/:leagueId/vote" element={<VotePage />} />
          <Route path="/leagues/:leagueId/reveal" element={<RevealPage />} />
          <Route path="/leagues/new" element={<Placeholder title="Create a League" />} />
          <Route path="/leagues/join" element={<Placeholder title="Join a League" />} />
          <Route path="/leagues" element={<Placeholder title="All Leagues" />} />
          <Route path="/rounds" element={<RoundsPage />} />
          <Route path="/leaderboard" element={<LeaderboardPage />} />
          <Route path="/profile" element={<ProfilePage />} />
          <Route path="*" element={<Placeholder title="Not Found" />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
