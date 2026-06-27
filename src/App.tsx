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
import { CreateLeaguePage } from "./pages/CreateLeaguePage";
import { JoinLeaguePage } from "./pages/JoinLeaguePage";
import { LeaguesPage } from "./pages/LeaguesPage";
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
          <Route path="/leagues/new" element={<CreateLeaguePage />} />
          <Route path="/leagues/join" element={<JoinLeaguePage />} />
          <Route path="/leagues" element={<LeaguesPage />} />
          <Route path="/rounds" element={<RoundsPage />} />
          <Route path="/leaderboard" element={<LeaderboardPage />} />
          <Route path="/profile" element={<ProfilePage />} />
          <Route path="*" element={<Placeholder title="Not Found" />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
