import { Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout';
import Login from './pages/Login';
import { useAuth } from './lib/auth';
import Dashboard from './pages/Dashboard';
import WhatsApp from './pages/WhatsApp';
import JDDetail from './pages/JDDetail';
import CandidateDetail from './pages/CandidateDetail';
// The manual side. Separate routes and separate pages from the WhatsApp
// screens above, because the data behind them is separate too.
import TalentPool from './pages/TalentPool';
import TalentDetail from './pages/TalentDetail';
import ManualRoles from './pages/ManualRoles';
import ManualRoleDetail from './pages/ManualRoleDetail';
import Meetings from './pages/Meetings';
import MeetingDetail from './pages/MeetingDetail';

export default function App() {
  const { status } = useAuth();

  // Nothing at all while the session is being checked. A spinner here would
  // flash on every load for the ~50ms the check takes, and rendering the app
  // optimistically would fire off a screen's worth of requests that are about
  // to 401.
  if (status === 'checking') return null;

  // Rendered INSTEAD of the routes, not as one of them. There is no path a
  // signed-out person can type that reaches a page which loads candidate data
  // — the routes do not exist to be matched.
  if (status !== 'authenticated') return <Login />;

  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        <Route path="/dashboard" element={<Dashboard />} />

        {/* The WhatsApp side is one destination with three tabs. The detail
            pages stay on their own paths — a single candidate is not a tab. */}
        <Route path="/whatsapp" element={<WhatsApp />} />
        <Route path="/jds/:id" element={<JDDetail />} />
        <Route path="/candidates/:id" element={<CandidateDetail />} />

        {/* The old list paths still resolve. Links to them exist in bookmarks
            and in the detail pages' own "back" navigation, and a dead route
            would strand both. */}
        <Route path="/jds" element={<Navigate to="/whatsapp?tab=messages" replace />} />
        <Route path="/candidates" element={<Navigate to="/whatsapp?tab=applicants" replace />} />
        <Route path="/review" element={<Navigate to="/whatsapp?tab=review" replace />} />

        <Route path="/talent" element={<TalentPool />} />
        <Route path="/talent/:id" element={<TalentDetail />} />
        <Route path="/roles" element={<ManualRoles />} />
        <Route path="/roles/:id" element={<ManualRoleDetail />} />
        <Route path="/meetings" element={<Meetings />} />
        <Route path="/meetings/:id" element={<MeetingDetail />} />

        {/* Anything else lands on the Overview.
            Without this, an unmatched path rendered the navigation with an
            empty space where the page should be — which reads as the app
            having broken rather than as a URL that does not exist. It is
            reachable by ordinary means: a typo, a stale bookmark, and
            /login in particular, which people try because every other site
            has one. There is no /login here — the sign-in screen replaces
            the whole app when there is no session, so a path for it would
            only ever be somewhere to land while already signed in. */}
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </Layout>
  );
}
